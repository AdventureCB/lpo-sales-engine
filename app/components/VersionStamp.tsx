"use client";

import { useEffect, useState } from "react";

/**
 * Deploy + companion version line for the Settings page. Web build comes from
 * /api/health (Vercel commit env); companion version via its app_version
 * command (added in 0.2.1 — older builds show "pre-0.2.1: update").
 */
export function VersionStamp() {
  const [web, setWeb] = useState<{ sha: string | null; at: string | null } | null>(null);
  const [companion, setCompanion] = useState<string | null>(null);
  const inCompanion = typeof window !== "undefined" && Boolean((window as any).__TAURI__);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setWeb({ sha: d.version?.sha ?? null, at: d.version?.deployedAt ?? null }))
      .catch(() => setWeb({ sha: null, at: null }));
    const tauri = (window as any).__TAURI__;
    if (tauri?.core?.invoke) {
      tauri.core
        .invoke("app_version")
        .then((v: string) => setCompanion(v))
        .catch(() => setCompanion("pre-0.2.1 — update"));
    }
  }, []);

  return (
    <span style={{ fontSize: 12, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>
      web {web?.sha ? web.sha.slice(0, 7) : "…"}
      {web?.at ? ` · deployed ${new Date(web.at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
      {inCompanion && <> · companion {companion ?? "…"}</>}
    </span>
  );
}
