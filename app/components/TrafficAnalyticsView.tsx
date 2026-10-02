"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Admin website-traffic analytics from Shopify's sessions data: any period
 * vs any comparison period (default = same dates last year). Daily series,
 * totals, sources, devices, and landing pages with movers.
 */

interface Totals { sessions: number; visitors: number; pageviews: number; atc: number; reached: number; completed: number; days: number; atcRate: number | null; checkoutRate: number | null; convRate: number | null; pvPerSession: number | null }
interface Day { day: string; sessions: number; visitors: number; atc: number; completed: number }
interface Group { key: string; sessions: number; atc: number; completed: number }
interface Period { from: string; to: string; totals: Totals; daily: Day[]; sources: Group[]; referrers: Group[]; devices: Group[]; pages: Group[]; pageWeeks: { count: number; from: string | null; to: string | null } }
interface Payload { a: Period; b: Period; coverageFrom: string | null; coverageTo: string | null; sync: { at?: string; ok?: boolean; error?: string } | null }
type Compare = "yoy" | "prior" | "custom";

const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());
const pct = (r: number | null | undefined, d = 1) => (r == null ? "—" : `${(r * 100).toFixed(d)}%`);
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s: string, n: number) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const addYears = (s: string, n: number) => { const d = parse(s); d.setFullYear(d.getFullYear() + n); return ymd(d); };
const dayCount = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000) + 1;
const fmtDate = (s: string) => parse(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtShort = (s: string) => parse(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const derived = (from: string, to: string, mode: Compare): [string, string] => (mode === "yoy" ? [addYears(from, -1), addYears(to, -1)] : [addDays(from, -dayCount(from, to)), addDays(to, -dayCount(from, to))]);
const COLOR_A = "var(--accent)", COLOR_B = "var(--accent-2)";

function Delta({ cur, prev, pts, higherIsBetter = true }: { cur: number | null | undefined; prev: number | null | undefined; pts?: boolean; higherIsBetter?: boolean }) {
  if (cur == null || prev == null) return <span style={{ fontSize: 11.5, color: "var(--text-3)" }}> · n/a</span>;
  const d = pts ? (cur - prev) * 100 : prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100;
  if (d == null || !Number.isFinite(d)) return <span style={{ fontSize: 11.5, color: "var(--text-3)" }}> · new</span>;
  if (Math.abs(d) < 0.05) return <span style={{ fontSize: 11.5, color: "var(--text-3)" }}> · flat</span>;
  const good = higherIsBetter ? d > 0 : d < 0;
  return <span style={{ fontSize: 11.5, fontWeight: 650, color: good ? "var(--good)" : "var(--crit)" }}> {d > 0 ? "▲" : "▼"}{Math.abs(d).toFixed(1)}{pts ? " pts" : "%"}</span>;
}

export function TrafficAnalyticsView() {
  const yesterday = useMemo(() => addDays(ymd(new Date()), -1), []);
  const presets = useMemo(() => {
    const t = yesterday;
    const som = `${t.slice(0, 7)}-01`;
    return [
      { key: "30", label: "Last 30 days", from: addDays(t, -29), to: t },
      { key: "90", label: "Last 90 days", from: addDays(t, -89), to: t },
      { key: "mtd", label: "Month to date", from: som, to: t },
      { key: "6m", label: "Last 6 months", from: addDays(`${t.slice(0, 7)}-01`, -153).slice(0, 7) + "-01", to: t },
      { key: "ytd", label: "Year to date", from: `${t.slice(0, 4)}-01-01`, to: t },
      { key: "365", label: "Last 12 months", from: addDays(t, -364), to: t },
    ];
  }, [yesterday]);
  const [from, setFrom] = useState(presets[0].from);
  const [to, setTo] = useState(presets[0].to);
  const [compare, setCompare] = useState<Compare>("yoy");
  const [cfrom, setCfrom] = useState(() => derived(presets[0].from, presets[0].to, "yoy")[0]);
  const [cto, setCto] = useState(() => derived(presets[0].from, presets[0].to, "yoy")[1]);
  const [metric, setMetric] = useState<"sessions" | "visitors" | "atc" | "completed">("sessions");
  const [tab, setTab] = useState<"pages" | "sources" | "referrers" | "devices">("pages");
  const [q, setQ] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => { if (compare === "custom") return; const [f, t] = derived(from, to, compare); setCfrom(f); setCto(t); }, [from, to, compare]);

  useEffect(() => {
    const my = ++seq.current;
    setLoading(true); setError(null);
    fetch(`/api/admin/analytics/traffic?from=${from}&to=${to}&cfrom=${cfrom}&cto=${cto}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (my !== seq.current) return; if (j.error) setError(j.error); else setData(j); })
      .catch((e) => my === seq.current && setError(String(e)))
      .finally(() => my === seq.current && setLoading(false));
  }, [from, to, cfrom, cto]);

  const a = data?.a ?? null, b = data?.b ?? null;
  const inputStyle: React.CSSProperties = { background: "var(--surface-2)", color: "var(--text-1)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 9px", fontSize: 13, fontVariantNumeric: "tabular-nums" };
  const th: React.CSSProperties = { textAlign: "right", padding: "7px 9px", fontSize: 11.5, color: "var(--text-3)", fontWeight: 700, whiteSpace: "nowrap", letterSpacing: "0.05em", textTransform: "uppercase", position: "sticky", top: 0, background: "var(--surface-1)" };
  const td: React.CSSProperties = { textAlign: "right", padding: "7px 9px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  const periodLabel = (f: string, t: string) => `${fmtDate(f)} – ${fmtDate(t)}`;
  const tile = (label: string, va: string, vb: string, d: React.ReactNode, sub?: string) => (
    <div className="stat-tile"><div className="n">{va}{d}</div><div className="l">{label}</div><div className="d">prior {vb}{sub ? ` · ${sub}` : ""}</div></div>
  );

  const listA: Group[] = (a ? (tab === "pages" ? a.pages : tab === "sources" ? a.sources : tab === "referrers" ? a.referrers : a.devices) : []);
  const listB = new Map<string, Group>((b ? (tab === "pages" ? b.pages : tab === "sources" ? b.sources : tab === "referrers" ? b.referrers : b.devices) : []).map((g) => [g.key, g]));
  const filtered = q ? listA.filter((g) => g.key.toLowerCase().includes(q.toLowerCase())) : listA;
  const movers = useMemo(() => {
    if (!a || !b) return null;
    const prev = new Map(b.pages.map((g) => [g.key, g]));
    const min = Math.max(30, Math.round(a.totals.sessions * 0.002));
    const ranked = a.pages.filter((g) => g.sessions >= min || (prev.get(g.key)?.sessions ?? 0) >= min).map((g) => { const p = prev.get(g.key); return { ...g, prev: p?.sessions ?? 0, change: p && p.sessions > 0 ? (g.sessions - p.sessions) / p.sessions : null }; });
    return {
      min,
      gainers: ranked.filter((g) => g.change != null && g.change > 0).sort((x, y) => y.change! - x.change!).slice(0, 5),
      decliners: ranked.filter((g) => g.change != null && g.change < 0).sort((x, y) => x.change! - y.change!).slice(0, 5),
      fresh: ranked.filter((g) => g.prev === 0 && g.sessions >= min).sort((x, y) => y.sessions - x.sessions).slice(0, 5),
    };
  }, [a, b]);

  return (
    <div>
      <h1 className="viewtitle">🌐 Website Traffic</h1>
      <p className="viewsub">Shopify&apos;s own session data for the online store: sessions, visitors, pageviews, add-to-cart and checkout rates, by day, source, device and landing page. Compare any period to the same dates last year or to the period before.</p>

      <div className="card" style={{ padding: "14px 18px", marginTop: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {presets.map((p) => (
            <button key={p.key} className={`btn ${p.from === from && p.to === to ? "primary" : "ghost"}`} style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => { setFrom(p.from); setTo(p.to); }}>{p.label}</button>
          ))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-end" }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-3)" }}>Period
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} style={inputStyle} /><span>→</span>
              <input type="date" value={to} min={from} max={yesterday} onChange={(e) => e.target.value && setTo(e.target.value)} style={inputStyle} />
            </span>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-3)" }}>Compare to
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select value={compare} onChange={(e) => setCompare(e.target.value as Compare)} style={inputStyle}>
                <option value="yoy">Same dates last year</option><option value="prior">Previous period</option><option value="custom">Custom</option>
              </select>
              <input type="date" value={cfrom} max={cto} disabled={compare !== "custom"} onChange={(e) => e.target.value && setCfrom(e.target.value)} style={{ ...inputStyle, opacity: compare === "custom" ? 1 : 0.6 }} /><span>→</span>
              <input type="date" value={cto} min={cfrom} disabled={compare !== "custom"} onChange={(e) => e.target.value && setCto(e.target.value)} style={{ ...inputStyle, opacity: compare === "custom" ? 1 : 0.6 }} />
            </span>
          </label>
          {loading && <span style={{ fontSize: 12, color: "var(--text-3)", paddingBottom: 8 }}>updating…</span>}
        </div>
      </div>

      {error && <p className="viewsub" style={{ color: "var(--crit)" }}>{error}</p>}
      {!data && !error && <p className="viewsub">Loading…</p>}

      {a && b && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 14, flexWrap: "wrap", gap: 8, fontSize: 13 }}>
            <div><b>{periodLabel(a.from, a.to)}</b><span style={{ color: "var(--text-3)" }}> vs {periodLabel(b.from, b.to)}</span></div>
            <div style={{ color: "var(--text-3)", fontSize: 12 }}>
              {data?.coverageFrom ? `data ${fmtShort(data.coverageFrom)} – ${data.coverageTo ? fmtDate(data.coverageTo) : ""}` : ""}
              {data?.sync?.ok === false && <span style={{ color: "var(--warn, #d9a441)", marginLeft: 8 }} title={data.sync.error}>nightly refresh failing — see note below</span>}
            </div>
          </div>
          {a.totals.days === 0 && <p className="viewsub" style={{ color: "var(--crit)" }}>No traffic data in this period.</p>}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginTop: 8 }}>
            {tile("Sessions", num(a.totals.sessions), num(b.totals.sessions), <Delta cur={a.totals.sessions} prev={b.totals.sessions} />, `${num(Math.round(a.totals.sessions / Math.max(a.totals.days, 1)))}/day`)}
            {tile("Visitors", num(a.totals.visitors), num(b.totals.visitors), <Delta cur={a.totals.visitors} prev={b.totals.visitors} />)}
            {tile("Pageviews", num(a.totals.pageviews), num(b.totals.pageviews), <Delta cur={a.totals.pageviews} prev={b.totals.pageviews} />, `${a.totals.pvPerSession?.toFixed(2) ?? "—"} per session`)}
            {tile("Add-to-cart rate", pct(a.totals.atcRate, 2), pct(b.totals.atcRate, 2), <Delta cur={a.totals.atcRate} prev={b.totals.atcRate} pts />, `${num(a.totals.atc)} sessions`)}
            {tile("Reached checkout", pct(a.totals.checkoutRate, 2), pct(b.totals.checkoutRate, 2), <Delta cur={a.totals.checkoutRate} prev={b.totals.checkoutRate} pts />, `${num(a.totals.reached)} sessions`)}
            {tile("Conversion rate", pct(a.totals.convRate, 2), pct(b.totals.convRate, 2), <Delta cur={a.totals.convRate} prev={b.totals.convRate} pts />, `${num(a.totals.completed)} checkouts`)}
          </div>

          <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
              <div style={{ fontWeight: 750 }}>By day</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12, color: "var(--text-3)", flexWrap: "wrap" }}>
                <span><span style={{ display: "inline-block", width: 14, borderTop: `3px solid ${COLOR_A}`, verticalAlign: "middle", marginRight: 5 }} />{periodLabel(a.from, a.to)}</span>
                <span><span style={{ display: "inline-block", width: 14, borderTop: `2px dashed ${COLOR_B}`, verticalAlign: "middle", marginRight: 5 }} />{periodLabel(b.from, b.to)}</span>
                <select value={metric} onChange={(e) => setMetric(e.target.value as any)} style={{ ...inputStyle, padding: "2px 6px", fontSize: 12 }}>
                  <option value="sessions">Sessions</option><option value="visitors">Visitors</option><option value="atc">Add-to-cart sessions</option><option value="completed">Checkouts</option>
                </select>
              </div>
            </div>
            <div style={{ opacity: loading ? 0.45 : 1, transition: "opacity 150ms" }}>
              <DailyChart a={a.daily} b={b.daily} metric={metric} />
            </div>
          </div>

          {movers && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, marginTop: 14 }}>
              {[{ t: "Landing pages gaining", rows: movers.gainers }, { t: "Landing pages losing", rows: movers.decliners }, { t: "New landing pages", rows: movers.fresh }].map((m) => (
                <div key={m.t} className="card" style={{ padding: "12px 16px" }}>
                  <div style={{ fontWeight: 750, marginBottom: 6 }}>{m.t}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 6 }}>vs the comparison period · pages with {movers.min}+ sessions</div>
                  {m.rows.length === 0 && <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>None</div>}
                  {m.rows.map((g) => (
                    <div key={g.key} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, padding: "4px 0", borderTop: "1px solid var(--border-soft)" }}>
                      <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={g.key}>{g.key}</span>
                      <span style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{num(g.sessions)}<Delta cur={g.sessions} prev={g.prev} /></span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 4 }}>
                {([["pages", "Landing pages"], ["sources", "Sources"], ["referrers", "Referrers"], ["devices", "Devices"]] as const).map(([k, l]) => (
                  <button key={k} className={`btn ${tab === k ? "primary" : "ghost"}`} style={{ padding: "4px 12px", fontSize: 13 }} onClick={() => setTab(k)}>{l}</button>
                ))}
              </div>
              <input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...inputStyle, width: 220 }} />
            </div>
            {tab === "pages" && <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 8 }}>Landing pages are summed by week ({a.pageWeeks.count} week{a.pageWeeks.count === 1 ? "" : "s"} overlapping this period{a.pageWeeks.from ? `, starting ${fmtShort(a.pageWeeks.from)}` : ""}), so their totals can differ slightly from the daily tiles. Top 300 pages by sessions.</div>}
            <div style={{ overflowX: "auto", maxHeight: 560, overflowY: "auto" }}>
              <table className="data-table" style={{ fontSize: 13, width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: "left" }}>{tab === "pages" ? "Landing page" : tab === "sources" ? "Source" : tab === "referrers" ? "Referrer" : "Device"}</th>
                    <th style={th}>Sessions</th><th style={th}>Share</th><th style={th}>Prior</th><th style={th}>Change</th>
                    {tab !== "devices" && <><th style={{ ...th, borderLeft: "1px solid var(--border)" }}>ATC rate</th><th style={th}>Conv. rate</th><th style={th}>Prior conv.</th></>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((g) => {
                    const p = listB.get(g.key);
                    const share = listA.reduce((s, x) => s + x.sessions, 0);
                    return (
                      <tr key={g.key}>
                        <td style={{ padding: "7px 9px", maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: tab === "pages" ? "ui-monospace, monospace" : undefined, fontSize: tab === "pages" ? 12 : 13 }} title={g.key}>{g.key}</td>
                        <td style={{ ...td, fontWeight: 650 }}>{num(g.sessions)}</td>
                        <td style={{ ...td, color: "var(--text-3)" }}>{share ? `${((g.sessions / share) * 100).toFixed(1)}%` : "—"}</td>
                        <td style={{ ...td, color: "var(--text-2)" }}>{num(p?.sessions ?? 0)}</td>
                        <td style={td}><Delta cur={g.sessions} prev={p?.sessions ?? 0} /></td>
                        {tab !== "devices" && <>
                          <td style={{ ...td, borderLeft: "1px solid var(--border)" }}>{g.sessions ? pct(g.atc / g.sessions, 2) : "—"}</td>
                          <td style={td}>{g.sessions ? pct(g.completed / g.sessions, 2) : "—"}</td>
                          <td style={{ ...td, color: "var(--text-2)" }}>{p && p.sessions ? pct(p.completed / p.sessions, 2) : "—"}</td>
                        </>}
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && <tr><td colSpan={8} style={{ padding: 14, color: "var(--text-3)" }}>Nothing here.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {data?.sync?.ok === false && (
            <div className="card" style={{ marginTop: 14, padding: "12px 18px", fontSize: 12.5, color: "var(--text-2)" }}>
              The nightly Shopify refresh is failing: <code style={{ fontSize: 12 }}>{data.sync.error}</code>. Reading analytics through the Admin API needs the <code>read_reports</code> scope and protected customer data (level 2) approved on the app in the Shopify Dev Dashboard. Until then the page shows history through {data.coverageTo ? fmtDate(data.coverageTo) : "the last seed"}.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DailyChart({ a, b, metric }: { a: Day[]; b: Day[]; metric: "sessions" | "visitors" | "atc" | "completed" }) {
  const n = Math.max(a.length, b.length);
  if (n === 0) return <div style={{ color: "var(--text-3)", fontSize: 13, padding: "16px 0" }}>No days in this period.</div>;
  const W = 900, H = 230, padL = 52, padR = 10, padT = 12, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const vals = [...a, ...b].map((d) => d[metric]);
  const max = Math.max(1, ...vals) * 1.08;
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const path = (rows: Day[]) => rows.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d[metric]).toFixed(1)}`).join(" ");
  const labelEvery = n > 60 ? Math.ceil(n / 12) : n > 20 ? Math.ceil(n / 10) : 1;
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 520, height: "auto", display: "block" }} role="img" aria-label="Daily traffic, this period vs comparison">
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <g key={i}><line x1={padL} x2={W - padR} y1={y(f * max)} y2={y(f * max)} stroke="var(--border-soft)" /><text x={padL - 6} y={y(f * max) + 4} fontSize={10} fill="var(--text-3)" textAnchor="end">{Math.round(f * max).toLocaleString()}</text></g>
        ))}
        {a.map((d, i) => i % labelEvery === 0 && <text key={d.day} x={x(i)} y={H - 8} fontSize={10} fill="var(--text-3)" textAnchor="middle">{fmtShort(d.day)}</text>)}
        <path d={path(b)} fill="none" stroke={COLOR_B} strokeWidth={1.5} strokeDasharray="5 4" opacity={0.75} />
        <path d={path(a)} fill="none" stroke={COLOR_A} strokeWidth={2.5} strokeLinejoin="round" />
        {a.map((d, i) => (
          <circle key={d.day} cx={x(i)} cy={y(d[metric])} r={n > 60 ? 2 : 3.5} fill={COLOR_A} stroke="var(--surface-1)" strokeWidth={1}>
            <title>{`${fmtDate(d.day)}: ${d[metric].toLocaleString()} ${metric}${b[i] ? ` · ${fmtDate(b[i].day)}: ${b[i][metric].toLocaleString()}` : ""}`}</title>
          </circle>
        ))}
      </svg>
      <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 4 }}>Days are aligned by position (1st day vs 1st day).</div>
    </div>
  );
}
