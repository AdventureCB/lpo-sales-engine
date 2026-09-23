"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

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
  beacon?: { lastAt: string | null; touches24h: number; linkedVisitors: number };
  funnel?: {
    total_leads: number;
    total_contacted: number;
    new_leads: number;
    new_attempted: number;
    new_contacted: number;
    avg_hours_first_attempt: number | null;
    avg_hours_first_contact: number | null;
  } | null;
  visitors?: {
    email: string;
    linkedAt: string;
    contactName: string | null;
    dealId: string | null;
    dealTitle: string | null;
    touches: number;
    firstAt: string | null;
    firstSource: string | null;
    firstLanding: string | null;
    lastSource: string | null;
    lastCampaign: string | null;
  }[];
}

const CHANNEL_LABEL: Record<string, string> = {
  google: "Google Ads", facebook: "Meta Ads", chatgpt: "ChatGPT Ads", microsoft: "Microsoft Ads",
  tiktok: "TikTok", pinterest: "Pinterest", snapchat: "Snapchat", reddit: "Reddit",
  linkedin: "LinkedIn", twitter: "X / Twitter",
};

const usd = (cents: number | null | undefined, digits = 0) =>
  cents == null ? "—" : `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: digits })}`;

interface FlowPoint { key: string; new: number; won: number; lost: number }
interface NewDealsReport {
  bucket: string;
  source: string | null;
  sources: string[];
  series: FlowPoint[];
  totals: { new: number; won: number; lost: number; openNow: number };
  bySource: { source: string; count: number }[];
}

const FLOW_LINES: { k: keyof Pick<FlowPoint, "new" | "won" | "lost">; label: string; color: string }[] = [
  { k: "new", label: "New", color: "var(--accent)" },
  { k: "won", label: "Won", color: "var(--good)" },
  { k: "lost", label: "Lost", color: "var(--crit)" },
];

/** Inline SVG line chart: new/won/lost per bucket. */
function FlowChart({ series, bucket }: { series: FlowPoint[]; bucket: string }) {
  const W = 760;
  const H = 210;
  const PAD = { l: 36, r: 12, t: 10, b: 24 };
  const max = Math.max(...series.flatMap((p) => [p.new, p.won, p.lost]), 1);
  const x = (i: number) => PAD.l + (series.length < 2 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (series.length - 1));
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const path = (get: (p: FlowPoint) => number) => series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`).join(" ");
  // At most ~8 x labels so day-granularity long ranges stay readable.
  const stepX = Math.max(1, Math.ceil(series.length / 8));
  const gridVals = [0, Math.round(max / 2), max];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img">
      {gridVals.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--border-soft)" strokeWidth={1} />
          <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize={10.5} fill="var(--text-3)">{v}</text>
        </g>
      ))}
      {series.map((p, i) =>
        i % stepX === 0 || i === series.length - 1 ? (
          <text key={p.key} x={x(i)} y={H - 6} textAnchor="middle" fontSize={10.5} fill="var(--text-3)">
            {bucketLabel(p.key, bucket).replace(/^Wk of /, "").replace(/^\w{3}, /, "")}
          </text>
        ) : null
      )}
      {FLOW_LINES.map(({ k, color }) => (
        <path key={k} d={path((p) => p[k])} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      ))}
      {FLOW_LINES.map(({ k, label, color }) =>
        series.map((p, i) => (
          <circle key={`${k}${p.key}`} cx={x(i)} cy={y(p[k])} r={3} fill={color}>
            <title>{`${bucketLabel(p.key, bucket)} — ${label}: ${p[k]}`}</title>
          </circle>
        ))
      )}
    </svg>
  );
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
  const [funnelDrill, setFunnelDrill] = useState<{ scope: "all" | "new"; tab: FunnelTab; label: string } | null>(null);
  const [exclHotlist, setExclHotlist] = useState(true);
  const [showVisitors, setShowVisitors] = useState(false);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New-deal counters — independent range so history back-loads to Aug 1.
  const [ndBucket, setNdBucket] = useState<"day" | "week" | "month">("day");
  const [ndStart, setNdStart] = useState("2026-08-01");
  const [ndEnd, setNdEnd] = useState(() => localDate(new Date()));
  const [ndSource, setNdSource] = useState("");
  const [nd, setNd] = useState<NewDealsReport | null>(null);
  const [ndErr, setNdErr] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    fetch(`/api/admin/ad-roi?days=${days}&excludeHotlist=${exclHotlist ? 1 : 0}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [days, exclHotlist]);

  useEffect(() => {
    if (!ndStart || !ndEnd || ndStart > ndEnd) return;
    setNdErr(null);
    fetch(`/api/admin/new-deals?start=${ndStart}&end=${ndEnd}&bucket=${ndBucket}&source=${encodeURIComponent(ndSource)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setNd)
      .catch((e) => setNdErr(String(e)));
  }, [ndStart, ndEnd, ndBucket, ndSource]);

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

      {data?.funnel && (() => {
        const f = data.funnel;
        const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
        const hrs = (h: number | null) =>
          h == null ? "—" : h < 24 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
        // Cards with a drill-down open the deal list (scope + starting tab).
        const card = (label: string, value: string, sub: string, drill?: { scope: "all" | "new"; tab: FunnelTab }) => (
          <div
            className="card"
            style={{ padding: "12px 14px", ...(drill ? { cursor: "pointer", borderColor: "var(--border)" } : {}) }}
            onClick={drill ? () => setFunnelDrill({ ...drill, label }) : undefined}
            title={drill ? "Click to see the deals behind this number" : undefined}
            role={drill ? "button" : undefined}
          >
            <div style={{ fontSize: 11.5, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}{drill ? " ↗" : ""}</div>
            <div style={{ fontSize: 24, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{value}</div>
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>{sub}</div>
          </div>
        );
        return (
          <>
            <div className="panel-h" style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 12 }}>
              📞 Lead contact funnel
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 400, color: "var(--text-2)", cursor: "pointer", marginLeft: "auto" }}>
                <input type="checkbox" checked={exclHotlist} onChange={(e) => setExclHotlist(e.target.checked)} style={{ cursor: "pointer" }} />
                exclude Hot List Import deals
              </label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 6 }}>
              {card("Contacted / all leads", `${f.total_contacted.toLocaleString()} / ${f.total_leads.toLocaleString()}`, `all-time · ${pct(f.total_contacted, f.total_leads)}`, { scope: "all", tab: "all" })}
              {card(`New leads attempted (${days}d)`, pct(f.new_attempted, f.new_leads), `${f.new_attempted} of ${f.new_leads} dialed at least once`, { scope: "new", tab: "attempted" })}
              {card(`New leads contacted (${days}d)`, pct(f.new_contacted, f.new_leads), `${f.new_contacted} of ${f.new_leads} had a real conversation`, { scope: "new", tab: "contacted" })}
              {card("Avg time to first attempt", hrs(f.avg_hours_first_attempt), `first dial, leads from last ${days}d`)}
              {card("Avg time to first contact", hrs(f.avg_hours_first_contact), `first real conversation`)}
            </div>
            <p className="viewsub" style={{ marginTop: 0 }}>
              Open deals only (won and lost drop out). Attempt = first outbound dial on the deal · contact = first real conversation
              (rep-dispositioned connected, or transcript-classified conversation — voicemail drops don&apos;t count). Click a card for the deals behind it.
            </p>
            {funnelDrill && (
              <FunnelLeadsModal
                label={funnelDrill.label}
                scope={funnelDrill.scope}
                initialTab={funnelDrill.tab}
                days={days}
                excludeHotlist={exclHotlist}
                onClose={() => setFunnelDrill(null)}
              />
            )}
          </>
        );
      })()}

      {data?.beacon && (() => {
        const b = data.beacon;
        const ageH = b.lastAt ? (Date.now() - Date.parse(b.lastAt)) / 3600_000 : null;
        const stale = ageH == null || ageH > 12;
        const ageLabel = ageH == null ? "never" : ageH < 1 ? `${Math.round(ageH * 60)}m ago` : `${Math.round(ageH)}h ago`;
        return (
          <p className="viewsub" style={{ marginTop: -6, color: stale ? "var(--crit)" : "var(--text-3)" }}>
            🛰 First-party beacon: last touch <b style={{ color: stale ? "var(--crit)" : "var(--text-2)" }}>{ageLabel}</b>
            {" "}· {b.touches24h} touch{b.touches24h === 1 ? "" : "es"} in 24h · {b.linkedVisitors} linked visitor{b.linkedVisitors === 1 ? "" : "s"}
            {stale ? " — beacon may be down, check /api/attr/touch" : ""}
            {(data?.visitors?.length ?? 0) > 0 && (
              <>
                {" "}·{" "}
                <button
                  onClick={() => setShowVisitors((v) => !v)}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent)", font: "inherit" }}
                >
                  {showVisitors ? "hide" : "show"} who
                </button>
              </>
            )}
          </p>
        );
      })()}

      {showVisitors && (data?.visitors?.length ?? 0) > 0 && (
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <table className="data-table" style={{ fontSize: 13 }}>
            <thead>
              <tr>
                <th>Linked</th><th>Who</th><th>Deal</th><th>Touches</th><th>First touch</th><th>Landing</th><th>Last paid source</th>
              </tr>
            </thead>
            <tbody>
              {data!.visitors!.map((v, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(v.linkedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td>{v.contactName ?? v.email}</td>
                  <td>
                    {v.dealId ? (
                      <Link href={`/crm/deal/${v.dealId}`} style={{ color: "var(--accent)" }}>{v.dealTitle ?? "deal"}</Link>
                    ) : (
                      <span style={{ color: "var(--text-3)" }}>—</span>
                    )}
                  </td>
                  <td>{v.touches}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {v.firstSource ?? <span style={{ color: "var(--text-3)" }}>organic/direct</span>}
                    {v.firstAt ? <span style={{ color: "var(--text-3)" }}> · {new Date(v.firstAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span> : null}
                  </td>
                  <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={v.firstLanding ?? undefined}>
                    {v.firstLanding ? v.firstLanding.replace(/^https?:\/\/[^/]+/, "") : "—"}
                  </td>
                  <td>{v.lastSource ?? "—"}{v.lastCampaign ? <span style={{ color: "var(--text-3)" }}> · {v.lastCampaign}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
          <b style={{ fontSize: 15 }}>📈 Deal flow</b>
          <div className="range-toggle" style={{ marginBottom: 0 }}>
            {(["day", "week", "month"] as const).map((b) => (
              <button key={b} className={ndBucket === b ? "active" : ""} onClick={() => setNdBucket(b)}>
                {b[0].toUpperCase() + b.slice(1)}
              </button>
            ))}
          </div>
          <select
            className="vmsel"
            style={{ width: "auto", fontSize: 12.5, padding: "4px 8px" }}
            value={ndSource}
            onChange={(e) => setNdSource(e.target.value)}
          >
            <option value="">All sources</option>
            {(nd?.sources ?? []).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginLeft: "auto" }}>
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
        {nd && (() => {
          const tt = nd.totals;
          const resolved = tt.won + tt.lost;
          return (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginTop: 14 }}>
                <div className="stat-tile"><div className="n">{tt.new.toLocaleString()}</div><div className="l">New deals</div></div>
                <div className="stat-tile"><div className="n" style={{ color: "var(--good)" }}>{tt.won.toLocaleString()}</div><div className="l">Won</div></div>
                <div className="stat-tile"><div className="n" style={{ color: "var(--crit)" }}>{tt.lost.toLocaleString()}</div><div className="l">Lost</div></div>
                <div className="stat-tile"><div className="n">{tt.openNow.toLocaleString()}</div><div className="l">Open now</div><div className="d">current, not range-bound</div></div>
                <div className="stat-tile"><div className="n">{resolved > 0 ? `${Math.round((tt.won / resolved) * 100)}%` : "—"}</div><div className="l">Conversion rate</div><div className="d">won ÷ resolved in range</div></div>
                <div className="stat-tile"><div className="n">{resolved > 0 ? `${Math.round((tt.lost / resolved) * 100)}%` : "—"}</div><div className="l">Loss rate</div><div className="d">lost ÷ resolved in range</div></div>
              </div>
              <div style={{ display: "flex", gap: 16, alignItems: "center", margin: "14px 0 4px", fontSize: 12.5 }}>
                {FLOW_LINES.map(({ k, label, color }) => (
                  <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-2)" }}>
                    <span style={{ width: 14, height: 3, background: color, borderRadius: 2, display: "inline-block" }} /> {label}
                  </span>
                ))}
                {ndSource && <span style={{ color: "var(--text-3)" }}>· {ndSource} only</span>}
              </div>
              {nd.series.length === 0 ? (
                <div style={{ color: "var(--text-3)", fontSize: 13.5, padding: "18px 0" }}>No deal activity in this range.</div>
              ) : (
                <FlowChart series={nd.series} bucket={nd.bucket} />
              )}
              {!ndSource && nd.bySource.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)", marginBottom: 8 }}>
                    New deals by source
                  </div>
                  <div style={{ maxHeight: 300, overflowY: "auto", display: "grid", gap: 4 }}>
                    {(() => {
                      const max = Math.max(...nd.bySource.map((s) => s.count), 1);
                      return nd.bySource.map((s) => (
                        <div key={s.source} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                          <span
                            style={{ width: 170, flexShrink: 0, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
                            title={`Filter to ${s.source}`}
                            onClick={() => setNdSource(s.source)}
                          >
                            {s.source}
                          </span>
                          <div style={{ flex: 1, height: 14, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
                            <div style={{ width: `${(s.count / max) * 100}%`, height: "100%", background: "var(--accent-2)", borderRadius: 4 }} />
                          </div>
                          <b style={{ width: 42, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{s.count}</b>
                          <span style={{ width: 44, textAlign: "right", fontSize: 12, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>
                            {tt.new > 0 ? `${Math.round((s.count / tt.new) * 100)}%` : ""}
                          </span>
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              )}
            </>
          );
        })()}
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

// ── Lead contact funnel drill-down ──────────────────────────────────────────
type FunnelTab = "all" | "contacted" | "attempted" | "untouched";
interface FunnelLead {
  id: string; title: string; createdAt: string; status: string; stage: string | null; source: string | null; owner: string | null;
  contactName: string | null; hasPhone: boolean; attemptAt: string | null; contactAt: string | null;
}
const TAB_LABEL: Record<FunnelTab, string> = { all: "All", contacted: "Contacted", attempted: "Attempted, no contact", untouched: "Not attempted" };
const bucketOf = (l: FunnelLead): Exclude<FunnelTab, "all"> => (l.contactAt ? "contacted" : l.attemptAt ? "attempted" : "untouched");
const BUCKET_COLOR: Record<Exclude<FunnelTab, "all">, string> = { contacted: "var(--good, #3aa76d)", attempted: "#d99a2b", untouched: "var(--crit, #c9502e)" };
const ago = (iso: string | null) => {
  if (!iso) return "—";
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}m ago` : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
};
const delay = (from: string, to: string | null) => {
  if (!to) return "";
  const h = (Date.parse(to) - Date.parse(from)) / 3_600_000;
  return h < 0 ? "" : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
};

/** The deals behind a funnel card: bucketed contacted / attempted-only / untouched, searchable, each row a link to the deal. */
function FunnelLeadsModal({ label, scope, initialTab, days, excludeHotlist, onClose }: {
  label: string; scope: "all" | "new"; initialTab: FunnelTab; days: number; excludeHotlist: boolean; onClose: () => void;
}) {
  const [rows, setRows] = useState<FunnelLead[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<FunnelTab>(initialTab);
  const [q, setQ] = useState("");
  useEffect(() => {
    setRows(null);
    fetch(`/api/admin/ad-roi/leads?scope=${scope}&days=${days}&excludeHotlist=${excludeHotlist ? 1 : 0}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { setRows(d.rows ?? []); setTruncated(!!d.truncated); })
      .catch((e) => setErr(String(e)));
  }, [scope, days, excludeHotlist]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const counts = { all: rows?.length ?? 0, contacted: 0, attempted: 0, untouched: 0 } as Record<FunnelTab, number>;
  for (const l of rows ?? []) counts[bucketOf(l)]++;
  const needle = q.trim().toLowerCase();
  const visible = (rows ?? [])
    .filter((l) => tab === "all" || bucketOf(l) === tab)
    .filter((l) => !needle || [l.title, l.contactName, l.source, l.owner, l.stage].some((v) => (v ?? "").toLowerCase().includes(needle)));

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(0,0,0,0.45)" }} onClick={onClose} />
      <div
        style={{
          position: "fixed", zIndex: 901, top: "5vh", left: "50%", transform: "translateX(-50%)", width: "min(1040px, 96vw)", maxHeight: "90vh",
          display: "flex", flexDirection: "column", background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 14,
          boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-soft)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <b style={{ fontSize: 15 }}>{label}</b>
          <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>
            {scope === "all" ? "all-time leads" : `leads created in the last ${days}d`}{excludeHotlist ? " · Hot List Import excluded" : ""}
            {truncated ? ` · showing the newest ${rows?.length.toLocaleString()}` : ""}
          </span>
          <input className="vmsel" placeholder="Search deal, contact, source, owner…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: "auto", width: 260 }} />
          <button className="btn ghost" style={{ padding: "3px 10px" }} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: "8px 16px 0", display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(["all", "contacted", "attempted", "untouched"] as FunnelTab[]).map((t) => (
            <button
              key={t}
              className="btn ghost"
              onClick={() => setTab(t)}
              style={{ padding: "3px 11px", fontSize: 12.5, borderRadius: 999, background: tab === t ? "var(--accent)" : "transparent", color: tab === t ? "#fff" : "var(--text-2)" }}
            >
              {t !== "all" && <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: tab === t ? "#fff" : BUCKET_COLOR[t], marginRight: 6 }} />}
              {TAB_LABEL[t]} {rows ? counts[t].toLocaleString() : ""}
            </button>
          ))}
        </div>
        <div style={{ overflow: "auto", padding: "8px 16px 14px" }}>
          {err && <div style={{ color: "var(--crit)", fontSize: 13 }}>{err}</div>}
          {!rows && !err && <div className="viewsub">Loading…</div>}
          {rows && visible.length === 0 && <div className="viewsub">Nothing here.</div>}
          {rows && visible.length > 0 && (
            <table className="data-table" style={{ fontSize: 13, width: "100%" }}>
              <thead>
                <tr>
                  <th>Created</th><th>Deal</th><th>Source</th><th>Owner</th><th>Stage</th><th>First attempt</th><th>First contact</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => {
                  const b = bucketOf(l);
                  return (
                    <tr key={l.id}>
                      <td style={{ whiteSpace: "nowrap", color: "var(--text-3)" }}>{new Date(l.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: scope === "all" ? "2-digit" : undefined })}</td>
                      <td style={{ minWidth: 200 }}>
                        <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: BUCKET_COLOR[b], marginRight: 7, verticalAlign: "middle" }} title={TAB_LABEL[b]} />
                        <Link href={`/crm/deal/${l.id}`} style={{ fontWeight: 600 }}>{l.title ?? l.contactName ?? "Open deal"}</Link>
                        {!l.hasPhone && <span style={{ fontSize: 11, color: "var(--crit)", marginLeft: 6 }} title="No usable phone on the contact">no phone</span>}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{l.source ?? "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{l.owner ? l.owner.split(" ")[0] : <span style={{ color: "var(--text-3)" }}>pool</span>}</td>
                      <td style={{ whiteSpace: "nowrap", color: "var(--text-2)" }}>{l.stage ?? "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }} title={l.attemptAt ?? ""}>
                        {l.attemptAt ? <>{ago(l.attemptAt)} <span style={{ color: "var(--text-3)" }}>({delay(l.createdAt, l.attemptAt)} after lead)</span></> : <span style={{ color: "var(--crit)" }}>never</span>}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }} title={l.contactAt ?? ""}>
                        {l.contactAt ? <>{ago(l.contactAt)} <span style={{ color: "var(--text-3)" }}>({delay(l.createdAt, l.contactAt)} after lead)</span></> : <span style={{ color: "var(--text-3)" }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
