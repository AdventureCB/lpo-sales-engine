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

export function VmPanel({
  selected,
  onSelect,
}: {
  selected: VmDrop | null;
  onSelect: (d: VmDrop | null) => void;
}) {
  const [drops, setDrops] = useState<VmDrop[]>([]);
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const [recName, setRecName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => chunksRef.current.push(e.data);
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setRecSec(0);
      timerRef.current = setInterval(() => setRecSec((s) => s + 1), 1000);
    } catch {
      setStatus("Mic access denied");
    }
  };

  const stopAndSave = async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (timerRef.current) clearInterval(timerRef.current);
    const name = recName.trim() || "Untitled drop";
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });
    rec.stream.getTracks().forEach((t) => t.stop());
    setRecording(false);
    setStatus("Processing…");
    try {
      const raw = new Blob(chunksRef.current);
      const ctx = new AudioContext();
      const decoded = await ctx.decodeAudioData(await raw.arrayBuffer());
      const wav = bufferToWav(decoded);
      const r = await fetch(`/api/vm-drops?name=${encodeURIComponent(name)}`, {
        method: "POST",
        body: wav,
      });
      setStatus(r.ok ? "Saved ✓" : "Upload failed");
      setRecName("");
      await load();
    } catch {
      setStatus("Processing failed");
    }
    setTimeout(() => setStatus(null), 2500);
  };

  const preview = () => {
    if (!selected?.url) return;
    if (!previewRef.current) previewRef.current = new Audio();
    previewRef.current.src = selected.url;
    void previewRef.current.play();
  };

  return (
    <div className="card">
      <div className="panel-h">Voicemail drop</div>
      <select
        className="vmsel"
        value={selected?.path ?? ""}
        onChange={(e) => onSelect(drops.find((d) => d.path === e.target.value) ?? null)}
      >
        {drops.length === 0 && <option value="">No recordings yet</option>}
        {drops.map((d) => (
          <option key={d.path} value={d.path}>{d.name}</option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn ghost" style={{ flex: 1, justifyContent: "center", fontSize: 12.5, padding: 8 }} onClick={preview} disabled={!selected?.url}>
          ▶ Preview
        </button>
        <button className="btn ghost" style={{ flex: 1, justifyContent: "center", fontSize: 12.5, padding: 8 }} onClick={startRec} disabled={recording}>
          ⏺ Record new
        </button>
      </div>
      {recording && (
        <div style={{ marginTop: 10, background: "var(--surface-2)", border: "1px solid rgba(208,59,59,.45)", borderRadius: 9, padding: "10px 12px" }}>
          <div style={{ fontSize: 13, color: "var(--crit)", fontWeight: 650 }}>
            Recording… {String(Math.floor(recSec / 60)).padStart(2, "0")}:{String(recSec % 60).padStart(2, "0")}
          </div>
          <input
            placeholder="Name this drop…"
            value={recName}
            onChange={(e) => setRecName(e.target.value)}
            style={{ width: "100%", marginTop: 10, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", color: "var(--text-1)", fontSize: 12.5 }}
          />
          <button className="btn primary" style={{ width: "100%", justifyContent: "center", fontSize: 12.5, padding: "8px 12px", marginTop: 8 }} onClick={stopAndSave}>
            ⏹ Stop &amp; save
          </button>
        </div>
      )}
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
