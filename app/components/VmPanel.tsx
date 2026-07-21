"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    __TAURI__?: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
  }
}

export interface VmDrop {
  name: string;
  path: string;
  url: string | null;
}

/** AudioBuffer → 16-bit PCM mono WAV (what the native player expects). */
function bufferToWav(buffer: AudioBuffer): Blob {
  const ch = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + ch.length * 2));
  const writeStr = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  writeStr(0, "RIFF");
  out.setUint32(4, 36 + ch.length * 2, true);
  writeStr(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, sampleRate, true);
  out.setUint32(28, sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  writeStr(36, "data");
  out.setUint32(40, ch.length * 2, true);
  for (let i = 0; i < ch.length; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: "audio/wav" });
}

type RecPhase = "idle" | "countdown" | "recording" | "naming" | "saving";

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--surface-1)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 10px",
  color: "var(--text-1)",
  fontSize: 12.5,
};

export function VmPanel({
  selected,
  onSelect,
}: {
  selected: VmDrop | null;
  onSelect: (d: VmDrop | null) => void;
}) {
  const [drops, setDrops] = useState<VmDrop[]>([]);
  const [phase, setPhase] = useState<RecPhase>("idle");
  const [countdown, setCountdown] = useState(3);
  const [recSec, setRecSec] = useState(0);
  const [recName, setRecName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const takenWavRef = useRef<Blob | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);

  const flash = (s: string) => {
    setStatus(s);
    setTimeout(() => setStatus(null), 2500);
  };

  const load = () =>
    fetch("/api/vm-drops")
      .then((r) => r.json())
      .then((d) => {
        setDrops(d.drops ?? []);
        if (!selected && d.drops?.[0]) onSelect(d.drops[0]);
      })
      .catch(() => {});

  useEffect(() => {
    load();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ⏺ → 3-2-1 countdown → recording */
  const startRec = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      flash("Mic access denied");
      return;
    }
    setPhase("countdown");
    setCountdown(3);
    let n = 3;
    timerRef.current = setInterval(() => {
      n -= 1;
      if (n > 0) {
        setCountdown(n);
        return;
      }
      if (timerRef.current) clearInterval(timerRef.current);
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => chunksRef.current.push(e.data);
      rec.start();
      recorderRef.current = rec;
      setPhase("recording");
      setRecSec(0);
      timerRef.current = setInterval(() => setRecSec((s) => s + 1), 1000);
    }, 1000);
  };

  /** ⏹ stop → decode take → naming step */
  const stopRec = async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (timerRef.current) clearInterval(timerRef.current);
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });
    rec.stream.getTracks().forEach((t) => t.stop());
    try {
      const raw = new Blob(chunksRef.current);
      const ctx = new AudioContext();
      const decoded = await ctx.decodeAudioData(await raw.arrayBuffer());
      takenWavRef.current = bufferToWav(decoded);
      setRecName("");
      setPhase("naming");
    } catch {
      flash("Processing failed");
      setPhase("idle");
    }
  };

  const playTake = () => {
    if (!takenWavRef.current) return;
    if (!previewRef.current) previewRef.current = new Audio();
    previewRef.current.src = URL.createObjectURL(takenWavRef.current);
    void previewRef.current.play();
  };

  const saveTake = async () => {
    const name = recName.trim();
    if (!name || !takenWavRef.current) return;
    setPhase("saving");
    const r = await fetch(`/api/vm-drops?name=${encodeURIComponent(name)}`, {
      method: "POST",
      body: takenWavRef.current,
    }).catch(() => null);
    flash(r?.ok ? "Saved ✓" : "Upload failed");
    takenWavRef.current = null;
    setPhase("idle");
    await load();
  };

  const discardTake = () => {
    takenWavRef.current = null;
    setPhase("idle");
  };

  const preview = () => {
    if (!selected?.url) return;
    if (!previewRef.current) previewRef.current = new Audio();
    previewRef.current.src = selected.url;
    void previewRef.current.play();
  };

  // window.confirm() is a silent no-op inside the Tauri webview — use a
  // two-click inline confirm instead.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const deleteSelected = async () => {
    if (!selected) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setTimeout(() => setConfirmingDelete(false), 3000);
      return;
    }
    setConfirmingDelete(false);
    await fetch(`/api/vm-drops?path=${encodeURIComponent(selected.path)}`, { method: "DELETE" });
    onSelect(null);
    await load();
    flash("Deleted");
  };

  const renameSelected = async () => {
    if (!selected || !renameVal.trim()) return;
    const r = await fetch("/api/vm-drops", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: selected.path, newName: renameVal.trim() }),
    }).catch(() => null);
    setRenaming(false);
    if (r?.ok) {
      onSelect(null);
      await load();
      flash("Renamed ✓");
    } else {
      flash("Rename failed");
    }
  };

  const busy = phase !== "idle";

  return (
    <div className="card">
      <div className="panel-h">Voicemail drop</div>
      <select
        className="vmsel"
        value={selected?.path ?? ""}
        onChange={(e) => onSelect(drops.find((d) => d.path === e.target.value) ?? null)}
        disabled={busy}
      >
        {drops.length === 0 && <option value="">No recordings yet</option>}
        {drops.map((d) => (
          <option key={d.path} value={d.path}>{d.name}</option>
        ))}
      </select>

      {!busy && (
        <>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <button className="btn ghost" style={{ flex: 1, justifyContent: "center", fontSize: 12.5, padding: 8 }} onClick={preview} disabled={!selected?.url}>
              ▶ Preview
            </button>
            <button className="btn ghost" style={{ flex: 1, justifyContent: "center", fontSize: 12.5, padding: 8 }} onClick={startRec}>
              ⏺ Record new
            </button>
          </div>
          {selected && (
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button
                className="btn ghost"
                style={{ flex: 1, justifyContent: "center", fontSize: 12, padding: 6 }}
                onClick={() => {
                  setRenaming(true);
                  setRenameVal(selected.name);
                }}
              >
                ✏️ Rename
              </button>
              <button
                className="btn ghost"
                style={{
                  flex: 1,
                  justifyContent: "center",
                  fontSize: 12,
                  padding: 6,
                  ...(confirmingDelete ? { background: "var(--crit)", color: "#fff", boxShadow: "none" } : {}),
                }}
                onClick={deleteSelected}
              >
                {confirmingDelete ? "Really delete?" : "🗑 Delete"}
              </button>
            </div>
          )}
          {renaming && (
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <input
                style={{ ...inputStyle, flex: 1 }}
                value={renameVal}
                onChange={(e) => setRenameVal(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && renameSelected()}
                autoFocus
              />
              <button className="btn primary" style={{ fontSize: 12, padding: "6px 10px" }} onClick={renameSelected}>
                Save
              </button>
              <button className="btn ghost" style={{ fontSize: 12, padding: "6px 10px" }} onClick={() => setRenaming(false)}>
                ✕
              </button>
            </div>
          )}
        </>
      )}

      {phase === "countdown" && (
        <div style={{ marginTop: 10, textAlign: "center", background: "var(--surface-2)", borderRadius: 9, padding: "18px 12px" }}>
          <div style={{ fontSize: 34, fontWeight: 800, color: "var(--accent-hover)" }}>{countdown}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4 }}>Recording starts…</div>
        </div>
      )}

      {phase === "recording" && (
        <div style={{ marginTop: 10, background: "var(--surface-2)", border: "1px solid rgba(208,59,59,.45)", borderRadius: 9, padding: "12px" }}>
          <div style={{ fontSize: 13, color: "var(--crit)", fontWeight: 650 }}>
            ● Recording {String(Math.floor(recSec / 60)).padStart(2, "0")}:{String(recSec % 60).padStart(2, "0")}
          </div>
          <button className="btn primary" style={{ width: "100%", justifyContent: "center", fontSize: 12.5, padding: "8px 12px", marginTop: 10 }} onClick={stopRec}>
            ⏹ Stop recording
          </button>
        </div>
      )}

      {phase === "naming" && (
        <div style={{ marginTop: 10, background: "var(--surface-2)", borderRadius: 9, padding: 12 }}>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", marginBottom: 8 }}>
            Take recorded ({recSec}s) — listen, then name it to save.
          </div>
          <button className="btn ghost" style={{ width: "100%", justifyContent: "center", fontSize: 12.5, padding: 7, marginBottom: 8 }} onClick={playTake}>
            ▶ Play take
          </button>
          <input
            placeholder="Name this drop… (e.g. First touch)"
            value={recName}
            onChange={(e) => setRecName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveTake()}
            style={inputStyle}
            autoFocus
          />
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button className="btn primary" style={{ flex: 1, justifyContent: "center", fontSize: 12.5, padding: "8px 12px" }} onClick={saveTake} disabled={!recName.trim()}>
              💾 Save
            </button>
            <button className="btn ghost" style={{ flex: 1, justifyContent: "center", fontSize: 12.5, padding: "8px 12px" }} onClick={discardTake}>
              Discard
            </button>
          </div>
        </div>
      )}

      {phase === "saving" && <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>Uploading…</div>}
      {status && <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>{status}</div>}
      <AudioSetup />
    </div>
  );
}

/** Companion-only: BlackHole/aggregate status + one-click audio setup. */
function AudioSetup() {
  const [state, setState] = useState<{ blackhole: boolean; aggregate: boolean } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [inTauri, setInTauri] = useState(false);

  const refresh = () => {
    window.__TAURI__?.core
      .invoke("audio_status")
      .then((s) => setState(s as { blackhole: boolean; aggregate: boolean }))
      .catch((e) => setBridgeError(String(e)));
  };

  useEffect(() => {
    if (window.__TAURI__) {
      setInTauri(true);
      refresh();
    }
  }, []);

  if (!inTauri) return null; // browser — audio setup is companion-only
  if (bridgeError) {
    return (
      <div style={{ marginTop: 12, borderTop: "1px solid var(--border-soft)", paddingTop: 10, fontSize: 12, color: "var(--crit)" }}>
        Companion bridge error: {bridgeError}
      </div>
    );
  }
  if (!state) {
    return (
      <div style={{ marginTop: 12, borderTop: "1px solid var(--border-soft)", paddingTop: 10, fontSize: 12, color: "var(--text-3)" }}>
        Checking audio devices…
      </div>
    );
  }

  const runSetup = async () => {
    setMsg("Setting up…");
    try {
      const result = await window.__TAURI__!.core.invoke("setup_audio");
      setMsg(String(result));
      refresh();
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--border-soft)", paddingTop: 10 }}>
      <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>
        BlackHole {state.blackhole ? "✓" : "✗ not installed"} · Mic+VM device{" "}
        {state.aggregate ? "✓" : "✗ missing"}
      </div>
      <button
        className="btn ghost"
        style={{ width: "100%", justifyContent: "center", fontSize: 12.5, padding: 8, marginTop: 8 }}
        onClick={runSetup}
        disabled={!state.blackhole}
        title={
          state.blackhole
            ? "Rebuilds the device around your current default microphone — use after switching headsets"
            : "Install BlackHole first (see SETUP.md)"
        }
      >
        {state.aggregate ? "⚙️ Recreate Mic + VM device (new headset?)" : "⚙️ Create Mic + VM device"}
      </button>
      {msg && <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 6 }}>{msg}</div>}
    </div>
  );
}
