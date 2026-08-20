"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * Cross-window page exclusivity. With multi-window use (companion aux window,
 * browser tab) two windows on the SAME page risk double-writes and stale
 * edits — so each window advertises the page it's on via localStorage
 * (shared across same-origin windows) and a window landing on an
 * already-held page gets a blocking overlay instead of the live page.
 *
 * Mechanics: one key per pathname, {win, at} heartbeat every 3s, 9s expiry
 * (crashed windows free their pages automatically). "Use here instead"
 * steals the lock; the other window sees the steal on its next beat and
 * blocks itself. The dialer additionally holds a lock on the deal it has
 * embedded (setExtraLock) so an aux window can't edit the lead mid-call —
 * extra locks are never re-stolen back, so a deliberate takeover sticks.
 */

const PREFIX = "lpo:pagelock:";
const HEARTBEAT_MS = 3000;
const FRESH_MS = 9000;

function winId(): string {
  try {
    let id = sessionStorage.getItem("lpoWinId");
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem("lpoWinId", id);
    }
    return id;
  } catch {
    return "w";
  }
}

type Lock = { win: string; at: number };
function readLock(key: string): Lock | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v && typeof v.at === "number" && typeof v.win === "string" ? v : null;
  } catch {
    return null;
  }
}
const fresh = (l: Lock | null): l is Lock => !!l && Date.now() - l.at < FRESH_MS;
function writeLock(key: string) {
  try {
    localStorage.setItem(key, JSON.stringify({ win: winId(), at: Date.now() }));
  } catch {}
}
function releaseLock(key: string) {
  const l = readLock(key);
  if (l?.win === winId()) {
    try {
      localStorage.removeItem(key);
    } catch {}
  }
}

// Extra path held alongside the current page (the dialer's embedded deal).
let extraPath: string | null = null;
export function setExtraLock(path: string | null) {
  if (extraPath && extraPath !== path) releaseLock(PREFIX + extraPath);
  extraPath = path;
}

export function PageLock() {
  const pathname = usePathname();
  const router = useRouter();
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    // /texts/chat: every popout shares this pathname (the conversation lives
    // in the query string) — locking it would block a second chat popout.
    if (!pathname || pathname.startsWith("/login") || pathname.startsWith("/texts/chat")) {
      setBlocked(false);
      return;
    }
    const key = PREFIX + pathname;
    const me = winId();

    const evaluate = () => {
      const l = readLock(key);
      const takenByOther = fresh(l) && l.win !== me;
      setBlocked(takenByOther);
      if (!takenByOther) {
        writeLock(key);
        // Dialer's embedded-deal lock: acquire only when free or already ours —
        // never steal it back after another window deliberately took over.
        if (extraPath && extraPath !== pathname) {
          const ek = PREFIX + extraPath;
          const el = readLock(ek);
          if (!fresh(el) || el.win === me) writeLock(ek);
        }
      }
      // Garbage-collect expired locks so localStorage doesn't accumulate.
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k?.startsWith(PREFIX) && !fresh(readLock(k))) localStorage.removeItem(k);
        }
      } catch {}
    };

    evaluate();
    const iv = setInterval(evaluate, HEARTBEAT_MS);
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.startsWith(PREFIX)) evaluate();
    };
    const release = () => {
      releaseLock(key);
      if (extraPath) releaseLock(PREFIX + extraPath);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pagehide", release);
    return () => {
      clearInterval(iv);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [pathname]);

  if (!blocked) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--surface-1, #0f1115) 82%, transparent)",
        backdropFilter: "blur(6px)",
      }}
    >
      <div
        className="card"
        style={{ maxWidth: 420, textAlign: "center", padding: "26px 28px", display: "grid", gap: 10 }}
      >
        <div style={{ fontSize: 34 }}>⧉</div>
        <div style={{ fontSize: 16, fontWeight: 750 }}>This page is open in your other window</div>
        <div style={{ fontSize: 13.5, color: "var(--text-3)", lineHeight: 1.5 }}>
          Two windows on the same page risk double-saving and stale edits, so only one can have it at a time.
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 4 }}>
          <button
            className="btn ghost"
            style={{ padding: "7px 16px" }}
            onClick={() => {
              if (window.history.length > 1) router.back();
              else router.push("/crm");
            }}
          >
            ← Go back
          </button>
          <button
            className="btn primary"
            style={{ padding: "7px 16px" }}
            onClick={() => {
              writeLock(PREFIX + pathname);
              setBlocked(false);
            }}
          >
            Use it here instead
          </button>
        </div>
      </div>
    </div>
  );
}
