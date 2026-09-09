"use client";

import { useEffect } from "react";

/**
 * Turns the companion's "tool-focus" events (native tool windows opened from
 * 🧰 Tools) into engagement sessions: focus starts a session, blur/close ends
 * it and posts to /api/engagement/tool-sessions. Runs only in the companion
 * main window; sub-minute noise is filtered server-side (<3s dropped).
 */
export function ToolFocusWatcher() {
  useEffect(() => {
    const t = (window as any).__TAURI__;
    if (!t?.event?.listen) return;
    const open = new Map<string, number>(); // label → focusedAt ms

    const close = (label: string, at: number) => {
      const started = open.get(label);
      open.delete(label);
      if (!started || at - started < 1000) return;
      void fetch("/api/engagement/tool-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: label,
          focusedAt: new Date(started).toISOString(),
          blurredAt: new Date(at).toISOString(),
        }),
        keepalive: true,
      }).catch(() => {});
    };

    let unlisten: (() => void) | null = null;
    void t.event
      .listen("tool-focus", (ev: { payload: { label: string; focused: boolean; idleFor?: number } }) => {
        const { label, focused, idleFor } = ev.payload ?? {};
        if (!label) return;
        const now = Date.now();
        if (focused) {
          if (!open.has(label)) open.set(label, now);
        } else {
          // Idle-triggered blur (companion ≥0.2.4): the rep stopped working
          // idleFor seconds ago — end the session THERE, not at detection.
          close(label, idleFor ? now - Math.round(idleFor * 1000) : now);
        }
      })
      .then((u: () => void) => {
        unlisten = u;
      })
      .catch(() => {});

    const flush = () => {
      const now = Date.now();
      for (const label of [...open.keys()]) close(label, now);
    };
    // Long focus stretches flush in 5-min chunks (close + restart) so a
    // main-window reload mid-session can't drop the accumulated time.
    const chunker = setInterval(() => {
      const now = Date.now();
      for (const [label, started] of [...open.entries()]) {
        if (now - started >= 5 * 60_000) {
          close(label, now);
          open.set(label, now);
        }
      }
    }, 30_000);
    window.addEventListener("beforeunload", flush);
    return () => {
      unlisten?.();
      clearInterval(chunker);
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, []);
  return null;
}
