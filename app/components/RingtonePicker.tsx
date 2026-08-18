"use client";

import { useEffect, useRef, useState } from "react";
import { getRingtoneKind, previewRingtone } from "./phoneClient";

const PRESETS: { kind: string; label: string }[] = [
  { kind: "classic", label: "☎️ Classic" },
  { kind: "digital", label: "📟 Digital" },
  { kind: "chime", label: "🔔 Chime" },
  { kind: "pulse", label: "💡 Pulse" },
  { kind: "custom", label: "🎵 My file" },
];

const MAX_BYTES = 1.5 * 1024 * 1024;

/**
 * Per-machine inbound ringtone. Presets are synthesized; "My file" plays an
 * uploaded audio file — import any ringtone you have (e.g. a Mac tone from
 * Finder) and it loops while a call rings.
 */
export function RingtonePicker() {
  const [kind, setKind] = useState("classic");
  const [hasCustom, setHasCustom] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setKind(getRingtoneKind());
    try {
      setHasCustom(Boolean(localStorage.getItem("ringtoneData")));
    } catch {}
  }, []);

  const pick = (k: string) => {
    if (k === "custom" && !hasCustom) {
      fileRef.current?.click();
      return;
    }
    setKind(k);
    try {
      localStorage.setItem("ringtone", k);
    } catch {}
    previewRingtone(k);
  };

  const upload = async (f: File) => {
    if (!f.type.startsWith("audio/") && !/\.(m4r|m4a|mp3|wav|aiff?)$/i.test(f.name)) {
      setMsg("Audio files only");
      return;
    }
    if (f.size > MAX_BYTES) {
      setMsg("Too large — keep it under 1.5MB");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error("read failed"));
      fr.readAsDataURL(f);
    });
    try {
      localStorage.setItem("ringtoneData", dataUrl);
      localStorage.setItem("ringtone", "custom");
    } catch {
      setMsg("Couldn't save — file may be too large for this browser");
      return;
    }
    setHasCustom(true);
    setKind("custom");
    setMsg(`Saved: ${f.name}`);
    previewRingtone("custom");
  };

  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 10 }}>
        Plays when a call rings in-app — saved on this machine. Click a tone to select &amp; preview.
        For a Mac ringtone, pick “My file” and choose the tone’s audio file.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {PRESETS.map((p) => (
          <button
            key={p.kind}
            className={`btn ${kind === p.kind ? "primary" : ""}`}
            style={{ padding: "7px 14px", fontSize: 13.5 }}
            onClick={() => pick(p.kind)}
          >
            {p.label}
          </button>
        ))}
        {hasCustom && (
          <button className="btn ghost" style={{ padding: "7px 12px", fontSize: 13 }} onClick={() => fileRef.current?.click()}>
            ⬆ Replace file
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.m4r,.m4a"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
      />
      {msg && <div style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 8 }}>{msg}</div>}
    </div>
  );
}
