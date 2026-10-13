"use client";

import { useEffect, useState } from "react";

/**
 * DTMF keypad for live calls (phone trees: "press 1 for sales"). Renders a
 * ⌨️ toggle; open, it shows a 3×4 grid and also takes 0-9 * # from the
 * keyboard. Each press sends one tone through `send`.
 */
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
const SUB: Record<string, string> = { 2: "ABC", 3: "DEF", 4: "GHI", 5: "JKL", 6: "MNO", 7: "PQRS", 8: "TUV", 9: "WXYZ", 0: "+" };

export function Keypad({ send, compact }: { send: (digit: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  const press = (d: string) => {
    try { send(d); } catch {}
    setTyped((t) => (t + d).slice(-24));
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (/^[0-9*#]$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        className="btn ghost"
        style={{ padding: compact ? "6px 10px" : "6px 10px", fontSize: 13, borderColor: open ? "var(--accent)" : undefined }}
        title="Keypad — press digits for phone menus"
        onClick={() => setOpen((v) => !v)}
      >
        ⌨️{compact ? "" : " Keypad"}
      </button>
      {open && (
        <div
          className="card"
          onClick={(e) => e.stopPropagation()}
          style={{ position: "absolute", bottom: "calc(100% + 8px)", right: 0, zIndex: 9000, width: 196, padding: 10, boxShadow: "0 10px 30px rgba(0,0,0,0.35)" }}
        >
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 15, minHeight: 22, textAlign: "center", color: typed ? "var(--text-1)" : "var(--text-3)", letterSpacing: 2, marginBottom: 8, overflow: "hidden", whiteSpace: "nowrap" }}>
            {typed || "type or tap"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
            {KEYS.map((k) => (
              <button
                key={k}
                className="btn ghost"
                style={{ padding: "8px 0", fontSize: 17, fontWeight: 700, lineHeight: 1.05, display: "flex", flexDirection: "column", alignItems: "center" }}
                onPointerDown={(e) => { e.preventDefault(); press(k); }}
              >
                {k}
                <span style={{ fontSize: 8.5, fontWeight: 600, color: "var(--text-3)", letterSpacing: 1, height: 10 }}>{SUB[k] ?? ""}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
