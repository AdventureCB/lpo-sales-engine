"use client";

import { useEffect, useState } from "react";

/**
 * Admin ad-ROI dashboard: per-channel spend, attributed leads (new deals),
 * CPL, won deals + value, cost-per-won — with blended CAC always shown
 * beside the attributed tier (coverage is partial by nature; the two are
 * never silently blended).
 */

interface ChannelStat {
  channel: string;
  spendCents: number;
  leads: number;
  cplCents: number | null;
  wonDeals: number;
  wonValueCents: number;
  costPerWonCents: number | null;
}

interface Report {
  days: number;
  channels: ChannelStat[];
  totals: {
    spendCents: number;
    newDeals: number;
    attributedDeals: number;
    blendedCacCents: number | null;
    wonDeals: number;
    wonValueCents: number;
  };
  organicSources: Record<string, number>;
}

const CHANNEL_LABEL: Record<string, string> = {
  google: "Google Ads", facebook: "Meta Ads", chatgpt: "ChatGPT Ads", microsoft: "Microsoft Ads",
  tiktok: "TikTok", pinterest: "Pinterest", snapchat: "Snapchat", reddit: "Reddit",
  linkedin: "LinkedIn", twitter: "X / Twitter",
};

const usd = (cents: number | null | undefined, digits = 0) =>
  cents == null ? "—" : `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: digits })}`;

interface NewDealsReport {
  total: number;
  bucket: string;
  buckets: { key: string; count: number }[];
  bySource: { source: string; count: number }[];
}

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "2026-08-11" → label per bucket granularity. */
const bucketLabel = (key: string, bucket: string) => {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (bucket === "month") return dt.toLocaleDateString([], { month: "short", year: "numeric" });
  if (bucket === "week") return `Wk of ${dt.toLocaleDateString([], { month: "short", day: "numeric" })}`;
  return dt.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
};

export function AdRoiView() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New-deal counters — independent range so history back-loads to Aug 1.
  const [ndBucket, setNdBucket] = useState<"day" | "week" | "month">("day");
  const [ndStart, setNdStart] = useState("2026-08-01");
  const [ndEnd, setNdEnd] = useState(() => localDate(new Date()));
  const [nd, setNd] = useState<NewDealsReport | null>(null);
  const [ndErr, setNdErr] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    fetch(`/api/admin/ad-roi?days=${days}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [days]);

  useEffect(() => {
    if (!ndStart || !ndEnd || ndStart > ndEnd) return;
    setNdErr(null);
    fetch(`/api/admin/new-deals?start=${ndStart}&end=${ndEnd}&bucket=${ndBucket}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setNd)
      .catch((e) => setNdErr(String(e)));
  }, [ndStart, ndEnd, ndBucket]);

  const ndPreset = (which: "7d" | "30d" | "month" | "aug") => {
    const now = new Date();
    if (which === "month") setNdStart(localDate(new Date(now.getFullYear(), now.getMonth(), 1)));
    else if (which === "aug") setNdStart("2026-08-01");
    else setNdStart(localDate(new Date(now.getTime() - (which === "7d" ? 6 : 29) * 86_400_000)));
    setNdEnd(localDate(now));
  };

  const t = data?.totals;
  const coverage = t && t.newDeals > 0 ? Math.round((t.attributedDeals / t.newDeals) * 100) : null;

  return (
    <div>
      <div className="viewhead"><h1>💰 Ad ROI</h1></div>
      <p className="viewsub">
        Spend (Triple Whale) joined to CRM deals via pixel journeys + first-party capture. Lead cost is
        channel-level; blended CAC shown beside it — attributed coverage is partial by nature.
      </p>

      <div className="range-toggle">
        {[30, 60, 90].map((d) => (
          <button key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>{d}d</button>
        ))}
      </div>

      {error && <p className="viewsub" style={{ color: "var(--crit)" }}>{error}</p>}
      {!data && !error && <p className="viewsub">Loading…</p>}

      {t && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 18 }}>
          <div className="stat-tile"><div className="n">{usd(t.spendCents)}</div><div className="l">Ad spend</div></div>
          <div className="stat-tile"><div className="n">{t.newDeals.toLocaleString()}</div><div className="l">New deals</div><div className="d">{coverage != null ? `${coverage}% attributed` : ""}</div></div>
          <div className="stat-tile"><div className="n">{usd(t.blendedCacCents)}</div><div className="l">Blended CAC</div><div className="d">spend ÷ all new deals</div></div>
          <div className="stat-tile"><div className="n">{t.wonDeals}</div><div className="l">Won deals</div></div>
          <div className="stat-tile"><div className="n">{usd(t.wonValueCents)}</div><div className="l">Won value</div></div>
        </div>
      )}

      {data && (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-3)", fontSize: 12 }}>
                {["Channel", "Spend", "Leads", "CPL", "Won", "Won value", "Cost / won", "ROAS (won)"].map((h) => (
                  <th key={h} style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-soft)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.channels.map((c) => (
                <tr key={c.channel} style={{ borderBottom: "1px solid var(--border-soft)" }}>
                  <td style={{ padding: "9px 14px", fontWeight: 650 }}>{CHANNEL_LABEL[c.channel] ?? c.channel}</td>
                  <td style={{ padding: "9px 14px", fontVariantNumeric: "tabular-nums" }}>{usd(c.spendCents)}</td>
                  <td style={{ padding: "9px 14px", fontVariantNumeric: "tabular-nums" }}>{c.leads}</td>
                  <td style={{ padding: "9px 14px", fontVariantNumeric: "tabular-nums", fontWeight: 650 }}>{usd(c.cplCents)}</td>
                  <td style={{ padding: "9px 14px", fontVariantNumeric: "tabular-nums" }}>{c.wonDeals}</td>
                  <td style={{ padding: "9px 14px", fontVariantNumeric: "tabular-nums" }}>{usd(c.wonValueCents)}</td>
                  <td style={{ padding: "9px 14px", fontVariantNumeric: "tabular-nums" }}>{usd(c.costPerWonCents)}</td>
                  <td style={{ padding: "9px 14px", fontVariantNumeric: "tabular-nums", color: c.spendCents > 0 && c.wonValueCents / c.spendCents >= 1 ? "var(--good)" : undefined }}>
                    {c.spendCents > 0 ? `${(c.wonValueCents / c.spendCents).toFixed(1)}×` : "—"}
                  </td>
                </tr>
              ))}
              {data.channels.length === 0 && (
                <tr><td colSpan={8} style={{ padding: 16, color: "var(--text-3)" }}>No spend or attributed leads in this window.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <b style={{ fontSize: 15 }}>🆕 New deals{nd ? ` — ${nd.total.toLocaleString()}` : ""}</b>
          <div className="range-toggle" style={{ marginBottom: 0 }}>
            {(["day", "week", "month"] as const).map((b) => (
              <button key={b} className={ndBucket === b ? "active" : ""} onClick={() => setNdBucket(b)}>
                {b[0].toUpperCase() + b.slice(1)}
              </button>
            ))}
          </div>
          <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {([["7d", "7d"], ["30d", "30d"], ["month", "This month"], ["aug", "Since Aug 1"]] as const).map(([k, l]) => (
              <button key={k} className="btn ghost" style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => ndPreset(k)}>
                {l}
              </button>
            ))}
            <input type="date" className="vmsel" style={{ width: "auto", fontSize: 12.5, padding: "4px 8px" }} value={ndStart} onChange={(e) => setNdStart(e.target.value)} />
            <span style={{ color: "var(--text-3)" }}>→</span>
            <input type="date" className="vmsel" style={{ width: "auto", fontSize: 12.5, padding: "4px 8px" }} value={ndEnd} onChange={(e) => setNdEnd(e.target.value)} />
          </span>
        </div>
        {ndErr && <div style={{ color: "var(--crit)", fontSize: 13, marginTop: 8 }}>{ndErr}</div>}
        {nd && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 20, marginTop: 14 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)", marginBottom: 8 }}>
                Per {nd.bucket}
              </div>
              {nd.buckets.length === 0 && <div style={{ color: "var(--text-3)", fontSize: 13.5 }}>No deals in this range.</div>}
              <div style={{ maxHeight: 340, overflowY: "auto", display: "grid", gap: 4 }}>
                {(() => {
                  const max = Math.max(...nd.buckets.map((b) => b.count), 1);
                  return nd.buckets.map((b) => (
                    <div key={b.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <span style={{ width: 110, flexShrink: 0, color: "var(--text-2)" }}>{bucketLabel(b.key, nd.bucket)}</span>
                      <div style={{ flex: 1, height: 14, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ width: `${(b.count / max) * 100}%`, height: "100%", background: "var(--accent)", borderRadius: 4 }} />
                      </div>
                      <b style={{ width: 42, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{b.count}</b>
                    </div>
                  ));
                })()}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)", marginBottom: 8 }}>
                By source
              </div>
              <div style={{ maxHeight: 340, overflowY: "auto", display: "grid", gap: 4 }}>
                {(() => {
                  const max = Math.max(...nd.bySource.map((s) => s.count), 1);
                  return nd.bySource.map((s) => (
                    <div key={s.source} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <span style={{ width: 150, flexShrink: 0, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.source}>
                        {s.source}
                      </span>
                      <div style={{ flex: 1, height: 14, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ width: `${(s.count / max) * 100}%`, height: "100%", background: "var(--accent-2)", borderRadius: 4 }} />
                      </div>
                      <b style={{ width: 42, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{s.count}</b>
                      <span style={{ width: 44, textAlign: "right", fontSize: 12, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>
                        {nd.total > 0 ? `${Math.round((s.count / nd.total) * 100)}%` : ""}
                      </span>
                    </div>
                  ));
                })()}
              </div>
            </div>
          </div>
        )}
      </div>

      {data && Object.keys(data.organicSources).length > 0 && (
        <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
          <b style={{ fontSize: 14 }}>Attributed non-paid sources</b>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8, fontSize: 13, color: "var(--text-2)" }}>
            {Object.entries(data.organicSources).sort((a, b) => b[1] - a[1]).map(([s, n]) => (
              <span key={s}>{s} <b>{n}</b></span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
