"use client";

import { useEffect, useState } from "react";
import { reportClientError } from "./components/ErrorReporter";

/**
 * Route-level error boundary — replaces Next's dead "Application error" black
 * screen. Reports the crash (stack → client_errors) and gives the rep a way
 * back without force-quitting the companion.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    reportClientError("boundary", error.message ?? "unknown", error.stack);
    // Two auto-heal cases, both network-shaped:
    // 1. Stale-deploy chunk misses (old client asking for pruned chunks).
    // 2. "Load failed" — WebKit's fetch/import network error, seen on flaky
    //    wifi (8/27: Jackson). One immediate reload can't help if the network
    //    is still down, so retry up to 3× with a 4s pause and show
    //    "reconnecting" instead of the crash screen.
    const networkShaped = /chunk|dynamically imported module|import\(\)|load failed|failed to fetch|network/i.test(
      `${error.name} ${error.message}`
    );
    if (networkShaped) {
      try {
        const n = Number(sessionStorage.getItem("chunk-reloaded") ?? 0);
        sessionStorage.setItem("chunk-reloaded", String(n + 1));
        setRetrying(true);
        // Fast first retry, then back off — and NEVER dead-end on the crash
        // screen while the network is out (8/31: office connection holes
        // outlasted the old 3-retry budget). Cap the interval at 15s and
        // keep trying until the connection returns.
        const delay = n === 0 ? 300 : Math.min(4000 * n, 15_000);
        setTimeout(() => window.location.reload(), delay);
        return;
      } catch {}
    } else {
      try {
        sessionStorage.removeItem("chunk-reloaded");
      } catch {}
    }
  }, [error]);

  if (retrying) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          background: "var(--surface-1, #0f1115)",
          color: "var(--text-1, #e7e9ec)",
        }}
      >
        <div style={{ fontSize: 32 }}>📶</div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Connection hiccup — reconnecting…</div>
        <div style={{ fontSize: 12.5, color: "var(--text-3, #9aa0a6)" }}>
          Waiting for your network. This retries automatically — if it persists, check your wifi.
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{ padding: "6px 16px", fontSize: 13, borderRadius: 8, border: "1px solid #444", background: "transparent", color: "inherit", cursor: "pointer" }}
        >
          Retry now
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 24,
        textAlign: "center",
        background: "var(--surface-1, #0f1115)",
        color: "var(--text-1, #e7e9ec)",
      }}
    >
      <div style={{ fontSize: 40 }}>😵</div>
      <div style={{ fontSize: 17, fontWeight: 700 }}>Something crashed</div>
      <div style={{ fontSize: 13.5, color: "var(--text-3, #9aa0a6)", maxWidth: 440, lineHeight: 1.5 }}>
        The error was reported automatically with its details. Reload to keep working — if it keeps happening, tell Kyle what you were doing right before.
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={() => reset()}
          style={{ padding: "8px 18px", fontSize: 14, borderRadius: 8, border: "1px solid var(--border-soft, #333)", background: "transparent", color: "inherit", cursor: "pointer" }}
        >
          Try again
        </button>
        <button
          onClick={() => window.location.reload()}
          style={{ padding: "8px 18px", fontSize: 14, borderRadius: 8, border: "none", background: "var(--accent, #4f7cff)", color: "#fff", cursor: "pointer" }}
        >
          Reload app
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-3, #9aa0a6)", maxWidth: 480, wordBreak: "break-word" }}>{error.message}</div>
    </div>
  );
}
