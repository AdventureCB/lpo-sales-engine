"use client";

import { useEffect } from "react";
import { reportClientError } from "./components/ErrorReporter";

/** Root-layout crash fallback — must render its own <html>/<body>. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportClientError("global", error.message ?? "unknown", error.stack);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 24,
          textAlign: "center",
          background: "#0f1115",
          color: "#e7e9ec",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ fontSize: 40 }}>😵</div>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Something crashed</div>
        <div style={{ fontSize: 13.5, color: "#9aa0a6", maxWidth: 440, lineHeight: 1.5 }}>
          The error was reported automatically. Reload to keep working.
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => reset()}
            style={{ padding: "8px 18px", fontSize: 14, borderRadius: 8, border: "1px solid #333", background: "transparent", color: "inherit", cursor: "pointer" }}
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "8px 18px", fontSize: 14, borderRadius: 8, border: "none", background: "#4f7cff", color: "#fff", cursor: "pointer" }}
          >
            Reload app
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: "#9aa0a6", maxWidth: 480, wordBreak: "break-word" }}>{error.message}</div>
      </body>
    </html>
  );
}
