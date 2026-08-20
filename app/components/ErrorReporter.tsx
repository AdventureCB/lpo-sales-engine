"use client";

import { useEffect } from "react";

// Session-scoped dedupe so a crash loop doesn't flood the table.
const seen = new Set<string>();

export function reportClientError(kind: string, message: string, stack?: string) {
  try {
    const key = `${kind}:${message}`.slice(0, 200);
    if (seen.has(key) || seen.size >= 10) return;
    seen.add(key);
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, message, stack, url: window.location.href }),
    }).catch(() => {});
  } catch {
    /* never let the reporter itself throw */
  }
}

/**
 * Renderless, root-mounted crash reporter. The companion's WKWebView has no
 * devtools, so uncaught errors are invisible without this — every crash lands
 * in client_errors with its stack.
 */
export function ErrorReporter() {
  useEffect(() => {
    const onErr = (e: ErrorEvent) => reportClientError("error", e.message ?? "unknown", e.error?.stack);
    const onRej = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: string; stack?: string } | undefined;
      reportClientError("rejection", String(r?.message ?? e.reason ?? "unknown"), r?.stack);
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);
  return null;
}
