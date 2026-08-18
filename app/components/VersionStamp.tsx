"use client";

import { useEffect, useState } from "react";

const RELEASES_LATEST_API = "https://api.github.com/repos/AdventureCB/lpo-sales-engine/releases/latest";
const RELEASES_LATEST_URL = "https://github.com/AdventureCB/lpo-sales-engine/releases/latest";

/** True when a < b for "x.y.z" version strings. */
function versionLt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Deploy + companion version line for the Settings pages. Web build comes
 * from /api/health; companion version via its app_version command. When the
 * running companion is behind the latest GitHub release, an update link
 * appears — native browser open where the companion supports it
 * (open_external, post-0.2.1), else the link is copied to the clipboard.
 */
export function VersionStamp() {
  const [web, setWeb] = useState<{ sha: string | null } | null>(null);
  const [companion, setCompanion] = useState<string | null>(null);
  const [latest, setLatest] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inCompanion = typeof window !== "undefined" && Boolean((window as any).__TAURI__);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setWeb({ sha: d.version?.sha ?? null }))
      .catch(() => setWeb({ sha: null }));
    const tauri = (window as any).__TAURI__;
    if (tauri?.core?.invoke) {
      tauri.core
        .invoke("app_version")
        .then((v: string) => setCompanion(v))
        .catch(() => setCompanion("pre-0.2.1"));
      // What's the newest published companion? (public repo, CORS-friendly)
      fetch(RELEASES_LATEST_API)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const tag = String(d?.tag_name ?? "").replace(/^v/, "");
          if (/^\d+\.\d+\.\d+$/.test(tag)) setLatest(tag);
        })
        .catch(() => {});
    }
  }, []);

  const outdated =
    inCompanion && latest !== null && companion !== null &&
    (companion === "pre-0.2.1" || versionLt(companion, latest));

  const openUpdate = async (e: React.MouseEvent) => {
    e.preventDefault();
    const tauri = (window as any).__TAURI__;
    try {
      await tauri.core.invoke("open_external", { url: RELEASES_LATEST_URL });
      return; // newer companion: opened in the default browser
    } catch {}
    try {
      await navigator.clipboard.writeText(RELEASES_LATEST_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 6000);
    } catch {}
  };

  return (
    <span style={{ fontSize: 12, color: "var(--text-3)", fontVariantNumeric: "tabular-nums", display: "inline-flex", gap: 6, alignItems: "center" }}>
      web {web?.sha ? web.sha.slice(0, 7) : "…"}
      {inCompanion && <> · companion {companion ?? "…"}</>}
      {outdated && (
        <a
          href={RELEASES_LATEST_URL}
          onClick={openUpdate}
          style={{ color: "var(--accent)", fontWeight: 700, cursor: "pointer" }}
          title="Get the latest companion app"
        >
          ⬆ Update to {latest}
        </a>
      )}
      {copied && <span style={{ color: "var(--good)" }}>link copied — paste into your browser ✓</span>}
    </span>
  );
}
