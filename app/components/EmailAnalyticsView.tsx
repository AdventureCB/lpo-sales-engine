"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Admin email-marketing analytics (Klaviyo): overall open/click rates per
 * month vs the same months a year earlier, plus per-flow and per-campaign
 * tables. Rates come from counts (unique opens ÷ delivered) so they roll up.
 */

interface Agg {
  recipients: number; delivered: number; opens: number; clicks: number; bounced: number; unsubscribes: number; spam: number; conversions: number; revenueCents: number;
  openRate: number | null; clickRate: number | null; ctor: number | null; unsubRate: number | null; bounceRate: number | null; convRate: number | null; rpr: number | null;
}
interface MonthRow { month: string; all: Agg; campaigns: Agg; flows: Agg }
interface Entity extends Agg { id: string; name: string; status: string | null; sendTime: string | null; firstMonth: string }
interface Report { from: string; to: string; months: MonthRow[]; totals: { all: Agg; campaigns: Agg; flows: Agg }; flows: Entity[]; campaigns: Entity[] }
interface Cohorts {
  subscribed: number; unsubscribed: number; neverSubscribed: number; suppressed: number; over6mo: number; over12mo: number;
  buckets: { key: string; count: number; engaged90: number }[]; syncedAt: string | null;
}
interface Payload { a: Report; b: Report | null; coverageFrom: string | null; lastRefreshAt: string | null; cohorts: Cohorts | null }
const BUCKET_LABEL: Record<string, string> = { "0": "Under 1 month", "1": "1–3 months", "2": "3–6 months", "3": "6–12 months", "4": "1–2 years", "5": "Over 2 years", unknown: "No date" };

const pct = (r: number | null | undefined, d = 1) => (r == null ? "—" : `${(r * 100).toFixed(d)}%`);
const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());
const usd = (c: number | null | undefined) => (c == null ? "—" : (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
const addMonths = (m: string, n: number) => { const [y, mo] = m.split("-").map(Number); const t = y * 12 + mo - 1 + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };
const monthLabel = (m: string, withYear = true) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString("en-US", withYear ? { month: "short", year: "2-digit" } : { month: "short" });
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

function Delta({ cur, prev, pts, higherIsBetter = true }: { cur: number | null | undefined; prev: number | null | undefined; pts?: boolean; higherIsBetter?: boolean }) {
  if (cur == null || prev == null) return null;
  const d = pts ? (cur - prev) * 100 : prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100;
  if (d == null || !Number.isFinite(d)) return null;
  if (Math.abs(d) < 0.05) return <span style={{ fontSize: 11.5, color: "var(--text-3)" }}> · flat</span>;
  const good = higherIsBetter ? d > 0 : d < 0;
  return <span style={{ fontSize: 11.5, fontWeight: 650, color: good ? "var(--good)" : "var(--crit)" }}> {d > 0 ? "▲" : "▼"}{Math.abs(d).toFixed(1)}{pts ? " pts" : "%"}</span>;
}

export function EmailAnalyticsView() {
  const [to, setTo] = useState(thisMonth);
  const [from, setFrom] = useState(() => addMonths(thisMonth(), -5));
  const [compare, setCompare] = useState(true);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"flows" | "campaigns">("flows");
  const [q, setQ] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/analytics/email?from=${from}&to=${to}&compare=${compare ? 1 : 0}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (my !== seq.current) return; if (j.error) setError(j.error); else setData(j); })
      .catch((e) => my === seq.current && setError(String(e)))
      .finally(() => my === seq.current && setLoading(false));
  }, [from, to, compare]);

  const presets = useMemo(() => {
    const t = thisMonth();
    return [
      { key: "6m", label: "Last 6 months", from: addMonths(t, -5), to: t },
      { key: "12m", label: "Last 12 months", from: addMonths(t, -11), to: t },
      { key: "ytd", label: "Year to date", from: `${t.slice(0, 4)}-01`, to: t },
      { key: "ly", label: "Last year", from: `${Number(t.slice(0, 4)) - 1}-01`, to: `${Number(t.slice(0, 4)) - 1}-12` },
    ];
  }, []);

  const a = data?.a ?? null;
  const b = data?.b ?? null;
  const prevByIdx = (i: number) => b?.months[i] ?? null;
  const prevFlow = (id: string) => b?.flows.find((f) => f.id === id) ?? null;
  const inputStyle: React.CSSProperties = { background: "var(--surface-2)", color: "var(--text-1)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 9px", fontSize: 13 };
  const th: React.CSSProperties = { textAlign: "right", padding: "7px 9px", fontSize: 11.5, color: "var(--text-3)", fontWeight: 700, whiteSpace: "nowrap", letterSpacing: "0.05em", textTransform: "uppercase", position: "sticky", top: 0, background: "var(--surface-1)" };
  const td: React.CSSProperties = { textAlign: "right", padding: "7px 9px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

  const tile = (label: string, value: string, delta: React.ReactNode, sub?: string) => (
    <div className="stat-tile"><div className="n">{value}{delta}</div><div className="l">{label}</div>{sub && <div className="d">{sub}</div>}</div>
  );

  const list = (tab === "flows" ? a?.flows : a?.campaigns) ?? [];
  const filtered = q ? list.filter((e) => e.name.toLowerCase().includes(q.toLowerCase())) : list;

  return (
    <div>
      <h1 className="viewtitle">✉️ Email Marketing</h1>
      <p className="viewsub">Klaviyo campaign and flow performance by month. Rates are unique opens or clicks ÷ delivered, recomputed from counts so months and groups add up. Apple Mail Privacy inflates opens everywhere; click rate is the honest signal.</p>

      <div className="card" style={{ padding: "12px 16px", display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {presets.map((p) => (
            <button key={p.key} className={`btn ${p.from === from && p.to === to ? "primary" : "ghost"}`} style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => { setFrom(p.from); setTo(p.to); }}>{p.label}</button>
          ))}
        </div>
        <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-3)" }}>
          Months
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="month" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} style={inputStyle} />
            <span>→</span>
            <input type="month" value={to} min={from} max={thisMonth()} onChange={(e) => e.target.value && setTo(e.target.value)} style={inputStyle} />
          </span>
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", paddingBottom: 6 }}>
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare to same months last year
        </label>
        {loading && <span style={{ fontSize: 12, color: "var(--text-3)", paddingBottom: 6 }}>updating…</span>}
      </div>

      {error && <p className="viewsub" style={{ color: "var(--crit)" }}>{error}</p>}
      {!data && !error && <p className="viewsub">Loading…</p>}

      {a && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 14, flexWrap: "wrap", gap: 8, fontSize: 13 }}>
            <div><b>{monthLabel(a.from)} – {monthLabel(a.to)}</b>{b && <span style={{ color: "var(--text-3)" }}> vs {monthLabel(b.from)} – {monthLabel(b.to)}</span>}</div>
            <div style={{ color: "var(--text-3)", fontSize: 12 }}>
              {data?.coverageFrom ? `data from ${monthLabel(data.coverageFrom.slice(0, 7))}` : ""}{data?.lastRefreshAt ? ` · refreshed ${new Date(data.lastRefreshAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginTop: 8 }}>
            {tile("Delivered", num(a.totals.all.delivered), <Delta cur={a.totals.all.delivered} prev={b?.totals.all.delivered} />, `${num(a.totals.campaigns.delivered)} campaign · ${num(a.totals.flows.delivered)} flow`)}
            {tile("Open rate", pct(a.totals.all.openRate), <Delta cur={a.totals.all.openRate} prev={b?.totals.all.openRate} pts />, `campaigns ${pct(a.totals.campaigns.openRate)} · flows ${pct(a.totals.flows.openRate)}`)}
            {tile("Click rate", pct(a.totals.all.clickRate, 2), <Delta cur={a.totals.all.clickRate} prev={b?.totals.all.clickRate} pts />, `campaigns ${pct(a.totals.campaigns.clickRate, 2)} · flows ${pct(a.totals.flows.clickRate, 2)}`)}
            {tile("Click-to-open", pct(a.totals.all.ctor), <Delta cur={a.totals.all.ctor} prev={b?.totals.all.ctor} pts />, "clicks ÷ opens")}
            {tile("Unsubscribe rate", pct(a.totals.all.unsubRate, 2), <Delta cur={a.totals.all.unsubRate} prev={b?.totals.all.unsubRate} pts higherIsBetter={false} />, `${num(a.totals.all.unsubscribes)} unsubs · ${num(a.totals.all.spam)} spam`)}
            {tile("Klaviyo-claimed revenue", usd(a.totals.all.revenueCents), <Delta cur={a.totals.all.revenueCents} prev={b?.totals.all.revenueCents} />, `${num(a.totals.all.conversions)} orders · Klaviyo's own attribution`)}
          </div>

          <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
              <div style={{ fontWeight: 750 }}>Open rate and click rate by month</div>
              <div style={{ fontSize: 12, color: "var(--text-3)", display: "flex", gap: 14, flexWrap: "wrap" }}>
                <span><span style={{ display: "inline-block", width: 14, borderTop: "3px solid var(--accent)", verticalAlign: "middle", marginRight: 5 }} />open rate</span>
                <span><span style={{ display: "inline-block", width: 14, borderTop: "3px solid #7aa7d9", verticalAlign: "middle", marginRight: 5 }} />click rate</span>
                {b && <span><span style={{ display: "inline-block", width: 14, borderTop: "2px dashed var(--text-3)", verticalAlign: "middle", marginRight: 5 }} />same months last year</span>}
              </div>
            </div>
            <div style={{ opacity: loading ? 0.45 : 1, transition: "opacity 150ms" }}>
              <RateChart a={a.months} b={b?.months ?? null} />
            </div>
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table className="data-table" style={{ fontSize: 13, width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: "left" }}>Month</th>
                    <th style={th}>Delivered</th><th style={th}>Open rate</th><th style={th}>Click rate</th><th style={th}>Unsub</th><th style={th}>Revenue</th>
                    {b && <><th style={{ ...th, borderLeft: "1px solid var(--border)" }}>Last year</th><th style={th}>Delivered</th><th style={th}>Open rate</th><th style={th}>Click rate</th></>}
                  </tr>
                </thead>
                <tbody>
                  {a.months.map((m, i) => {
                    const p = prevByIdx(i);
                    return (
                      <tr key={m.month}>
                        <td style={{ padding: "7px 9px" }}>{monthLabel(m.month)}</td>
                        <td style={td}>{num(m.all.delivered)}</td>
                        <td style={{ ...td, fontWeight: 650 }}>{pct(m.all.openRate)}<Delta cur={m.all.openRate} prev={p?.all.openRate} pts /></td>
                        <td style={{ ...td, fontWeight: 650 }}>{pct(m.all.clickRate, 2)}<Delta cur={m.all.clickRate} prev={p?.all.clickRate} pts /></td>
                        <td style={td}>{pct(m.all.unsubRate, 2)}</td>
                        <td style={{ ...td, color: "var(--text-3)" }}>{usd(m.all.revenueCents)}</td>
                        {b && <>
                          <td style={{ ...td, textAlign: "left", borderLeft: "1px solid var(--border)", color: "var(--text-2)" }}>{p ? monthLabel(p.month) : "—"}</td>
                          <td style={{ ...td, color: "var(--text-2)" }}>{num(p?.all.delivered)}</td>
                          <td style={{ ...td, color: "var(--text-2)" }}>{pct(p?.all.openRate)}</td>
                          <td style={{ ...td, color: "var(--text-2)" }}>{pct(p?.all.clickRate, 2)}</td>
                        </>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {data?.cohorts && (() => {
            const c = data.cohorts;
            const total = c.subscribed || 1;
            const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
            const maxN = Math.max(1, ...c.buckets.map((b) => b.count));
            return (
              <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ fontWeight: 750 }}>How long subscribers have been getting our email</div>
                  <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                    {num(c.subscribed)} subscribed · {num(c.unsubscribed)} unsubscribed · {num(c.suppressed)} suppressed{c.syncedAt ? ` · synced ${new Date(c.syncedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-3)", margin: "4px 0 10px" }}>
                  Current email subscribers in Klaviyo, grouped by time since they consented to marketing email (profile creation date when consent has no timestamp). The engaged share is subscribers who opened or clicked an email in the last 90 days.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 12 }}>
                  <div className="stat-tile"><div className="n">{pct(c.over6mo)}</div><div className="l">6 months or longer</div><div className="d">{num(c.over6mo)} subscribers</div></div>
                  <div className="stat-tile"><div className="n">{pct(c.over12mo)}</div><div className="l">A year or longer</div><div className="d">{num(c.over12mo)} subscribers</div></div>
                  <div className="stat-tile"><div className="n">{pct(c.subscribed - c.over6mo)}</div><div className="l">Under 6 months</div><div className="d">{num(c.subscribed - c.over6mo)} subscribers</div></div>
                </div>
                <table className="data-table" style={{ fontSize: 13, width: "100%" }}>
                  <thead><tr><th>Tenure</th><th style={{ width: "40%" }}></th><th style={{ textAlign: "right" }}>Subscribers</th><th style={{ textAlign: "right" }}>Share</th><th style={{ textAlign: "right" }}>Engaged (90d)</th></tr></thead>
                  <tbody>
                    {c.buckets.map((b) => (
                      <tr key={b.key}>
                        <td style={{ whiteSpace: "nowrap" }}>{BUCKET_LABEL[b.key] ?? b.key}</td>
                        <td><div style={{ height: 10, borderRadius: 3, background: "var(--accent)", width: `${(b.count / maxN) * 100}%`, minWidth: 2 }} /></td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 650 }}>{num(b.count)}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{pct(b.count)}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-2)" }}>{b.count ? `${((b.engaged90 / b.count) * 100).toFixed(0)}%` : "—"}</td>
                      </tr>
                    ))}
                    {c.buckets.length === 0 && <tr><td colSpan={5} style={{ color: "var(--text-3)" }}>Profile sync hasn&apos;t run yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            );
          })()}

          <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 4 }}>
                <button className={`btn ${tab === "flows" ? "primary" : "ghost"}`} style={{ padding: "4px 12px", fontSize: 13 }} onClick={() => setTab("flows")}>Flows ({a.flows.length})</button>
                <button className={`btn ${tab === "campaigns" ? "primary" : "ghost"}`} style={{ padding: "4px 12px", fontSize: 13 }} onClick={() => setTab("campaigns")}>Campaigns ({a.campaigns.length})</button>
              </div>
              <input placeholder="Filter by name…" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...inputStyle, width: 220 }} />
            </div>
            <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 8 }}>
              {tab === "flows"
                ? `Flow totals over ${monthLabel(a.from)} – ${monthLabel(a.to)}; the comparison column is the same flow over the same months a year earlier.`
                : "Campaigns are one-off sends, listed newest first, with their own open and click rates. Compare them against the campaign average in the tiles above."}
            </div>
            <div style={{ overflowX: "auto", maxHeight: 560, overflowY: "auto" }}>
              <table className="data-table" style={{ fontSize: 13, width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: "left" }}>{tab === "flows" ? "Flow" : "Campaign"}</th>
                    {tab === "campaigns" && <th style={{ ...th, textAlign: "left" }}>Sent</th>}
                    <th style={th}>Delivered</th><th style={th}>Open rate</th><th style={th}>Click rate</th><th style={th}>CTOR</th><th style={th}>Unsub</th><th style={th}>Orders</th><th style={th}>Revenue</th>
                    {tab === "flows" && b && <><th style={{ ...th, borderLeft: "1px solid var(--border)" }}>LY delivered</th><th style={th}>LY open</th><th style={th}>LY click</th></>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => {
                    const p = tab === "flows" ? prevFlow(e.id) : null;
                    return (
                      <tr key={e.id}>
                        <td style={{ padding: "7px 9px", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${e.name} · ${e.id}${e.status ? ` · ${e.status}` : ""}`}>
                          {e.name}{e.status && e.status !== "live" && e.status !== "Sent" && e.status !== "sent" ? <span style={{ fontSize: 11, color: "var(--text-3)", marginLeft: 6 }}>{e.status}</span> : null}
                        </td>
                        {tab === "campaigns" && <td style={{ padding: "7px 9px", color: "var(--text-2)", whiteSpace: "nowrap" }}>{e.sendTime ? new Date(e.sendTime).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) : monthLabel(e.firstMonth)}</td>}
                        <td style={td}>{num(e.delivered)}</td>
                        <td style={{ ...td, fontWeight: 650 }}>{pct(e.openRate)}{p && <Delta cur={e.openRate} prev={p.openRate} pts />}</td>
                        <td style={{ ...td, fontWeight: 650 }}>{pct(e.clickRate, 2)}{p && <Delta cur={e.clickRate} prev={p.clickRate} pts />}</td>
                        <td style={td}>{pct(e.ctor)}</td>
                        <td style={td}>{pct(e.unsubRate, 2)}</td>
                        <td style={td}>{num(e.conversions)}</td>
                        <td style={{ ...td, color: "var(--text-3)" }}>{usd(e.revenueCents)}</td>
                        {tab === "flows" && b && <>
                          <td style={{ ...td, borderLeft: "1px solid var(--border)", color: "var(--text-2)" }}>{num(p?.delivered)}</td>
                          <td style={{ ...td, color: "var(--text-2)" }}>{pct(p?.openRate)}</td>
                          <td style={{ ...td, color: "var(--text-2)" }}>{pct(p?.clickRate, 2)}</td>
                        </>}
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && <tr><td colSpan={12} style={{ padding: 14, color: "var(--text-3)" }}>Nothing in this window{q ? " matching that filter" : ""}.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RateChart({ a, b }: { a: MonthRow[]; b: MonthRow[] | null }) {
  const n = a.length;
  if (n === 0) return null;
  const W = 900, H = 230, padL = 48, padR = 48, padT = 12, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const openVals = [...a.map((m) => m.all.openRate), ...(b ?? []).map((m) => m.all.openRate)].filter((v): v is number => v != null);
  const clickVals = [...a.map((m) => m.all.clickRate), ...(b ?? []).map((m) => m.all.clickRate)].filter((v): v is number => v != null);
  const oMax = Math.max(0.05, ...openVals) * 1.1, cMax = Math.max(0.005, ...clickVals) * 1.1;
  const yO = (v: number) => padT + innerH - (v / oMax) * innerH;
  const yC = (v: number) => padT + innerH - (v / cMax) * innerH;
  // Months with no sends break the line rather than drawing to zero.
  const path = (rows: MonthRow[], pick: (m: MonthRow) => number | null, y: (v: number) => number) => {
    let d = "";
    let pen = false;
    rows.forEach((m, i) => {
      const v = pick(m);
      if (v == null) { pen = false; return; }
      d += `${pen ? " L" : " M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d.trim();
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 520, height: "auto", display: "block" }} role="img" aria-label="Open rate and click rate by month">
        {ticks.map((f, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={padT + innerH - f * innerH} y2={padT + innerH - f * innerH} stroke="var(--border-soft)" />
            <text x={padL - 6} y={padT + innerH - f * innerH + 4} fontSize={10} fill="var(--accent)" textAnchor="end">{(f * oMax * 100).toFixed(0)}%</text>
            <text x={W - padR + 6} y={padT + innerH - f * innerH + 4} fontSize={10} fill="#7aa7d9" textAnchor="start">{(f * cMax * 100).toFixed(1)}%</text>
          </g>
        ))}
        {a.map((m, i) => <text key={m.month} x={x(i)} y={H - 8} fontSize={10} fill="var(--text-3)" textAnchor="middle">{monthLabel(m.month, n > 12 ? true : false)}</text>)}
        {b && <path d={path(b, (m) => m.all.openRate, yO)} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="5 4" opacity={0.6} />}
        {b && <path d={path(b, (m) => m.all.clickRate, yC)} fill="none" stroke="#7aa7d9" strokeWidth={1.5} strokeDasharray="5 4" opacity={0.6} />}
        <path d={path(a, (m) => m.all.openRate, yO)} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" />
        <path d={path(a, (m) => m.all.clickRate, yC)} fill="none" stroke="#7aa7d9" strokeWidth={2.5} strokeLinejoin="round" />
        {a.map((m, i) => (
          <g key={m.month}>
            {m.all.openRate != null && <circle cx={x(i)} cy={yO(m.all.openRate)} r={4} fill="var(--accent)" stroke="var(--surface-1)" strokeWidth={1.5}><title>{`${monthLabel(m.month)}: open ${pct(m.all.openRate)} · ${num(m.all.delivered)} delivered${b?.[i] ? ` · last year ${pct(b[i].all.openRate)}` : ""}`}</title></circle>}
            {m.all.clickRate != null && <circle cx={x(i)} cy={yC(m.all.clickRate)} r={4} fill="#7aa7d9" stroke="var(--surface-1)" strokeWidth={1.5}><title>{`${monthLabel(m.month)}: click ${pct(m.all.clickRate, 2)}${b?.[i] ? ` · last year ${pct(b[i].all.clickRate, 2)}` : ""}`}</title></circle>}
          </g>
        ))}
      </svg>
      <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 4 }}>Left axis: open rate. Right axis: click rate. Dashed lines are the same months one year earlier.</div>
    </div>
  );
}
