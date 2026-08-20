"use client";

import { useEffect } from "react";
import { reportClientError } from "./components/ErrorReporter";

/**
 * Route-level error boundary — replaces Next's dead "Application error" black
 * screen. Reports the crash (stack → client_errors) and gives the rep a way
 * back without force-quitting the companion.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportClientError("boundary", error.message ?? "unknown", error.stack);
    // Stale-deploy chunk misses (old client asking for pruned chunks after a
    // push) heal with one reload — do it automatically, once, so reps never
    // see this page for that case.
    if (/chunk|dynamically imported module|import\(\)/i.test(`${error.name} ${error.message}`)) {
      try {
        if (!sessionStorage.getItem("chunk-reloaded")) {
          sessionStorage.setItem("chunk-reloaded", "1");
          window.location.reload();
        }
      } catch {}
    } else {
      try {
        sessionStorage.removeItem("chunk-reloaded");
      } catch {}
    }
  }, [error]);

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
