"use client";

import { useEffect, useState } from "react";

const REPO = "AdventureCB/lpo-sales-engine";

/**
 * Admin Settings card: the newest companion (LPO Queue Runner) release with
 * two copyable links — the PERMANENT /download/companion link (always
 * redirects to the latest installer; hand this one out) and the direct
 * versioned asset. Reads the public GitHub releases API (CORS-friendly).
 */
export function CompanionDownloadCard() {
  const [rel, setRel] = useState<{ tag: string; name: string | null; publishedAt: string | null; asset: { name: string; url: string; downloads: number } | null } | null | "error">(null);
  const [copied, setCopied] = useState<string | null>(null);
  const stable = typeof window !== "undefined" ? `${window.location.origin}/download/companion` : "/download/companion";

  useEffect(() => {
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        const assets: any[] = d.assets ?? [];
        const a = assets.find((x) => /installer\.zip$/i.test(x.name)) ?? assets[0] ?? null;
        setRel({
          tag: String(d.tag_name ?? "").replace(/^v/, ""),
          name: d.name ?? null,
          publishedAt: d.published_at ?? null,
          asset: a ? { name: a.name, url: a.browser_download_url, downloads: Number(a.download_count ?? 0) } : null,
        });
      })
      .catch(() => setRel("error"));
  }, []);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };
  const row = (label: string, url: string, hint: string) => (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <b style={{ minWidth: 120 }}>{label}</b>
      <code style={{ fontSize: 12.5, wordBreak: "break-all" }}>{url}</code>
      <button className="btn ghost" style={{ padding: "2px 10px", fontSize: 12.5 }} onClick={() => copy(url)}>{copied === url ? "Copied ✓" : "Copy"}</button>
      <span style={{ fontSize: 12, color: "var(--text-3)", flexBasis: "100%" }}>{hint}</span>
    </div>
  );

  return (
    <div className="card" style={{ maxWidth: 680, marginBottom: 18 }}>
      <div className="panel-h">🧰 Companion app download</div>
      {rel === null && <div className="viewsub" style={{ marginTop: 0 }}>Checking the latest release…</div>}
      {rel === "error" && <div className="viewsub" style={{ marginTop: 0, color: "var(--crit)" }}>Couldn't reach GitHub — the permanent link below still works.</div>}
      {rel && rel !== "error" && (
        <div className="viewsub" style={{ marginTop: 0 }}>
          Latest: <b style={{ color: "var(--text-1)" }}>{rel.tag}</b>{rel.name ? ` — ${rel.name.replace(/^Companion\s+[\d.]+\s*[—-]?\s*/, "")}` : ""}
          {rel.publishedAt ? ` · released ${new Date(rel.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}
          {rel.asset ? ` · ${rel.asset.downloads} download${rel.asset.downloads === 1 ? "" : "s"}` : ""}
        </div>
      )}
      <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
        {row("Permanent link", stable, "Always points at the newest installer — this is the one to hand out or bookmark.")}
        {rel && rel !== "error" && rel.asset && row(`Direct (${rel.tag})`, rel.asset.url, `${rel.asset.name} — this exact version; goes stale on the next release.`)}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 10 }}>
        Reps on an older build see an "⬆ Update" prompt in their Settings automatically. <a href={`https://github.com/${REPO}/releases`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>All releases ↗</a>
      </div>
    </div>
  );
}
