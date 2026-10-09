"use client";

import { useEffect, useState } from "react";

interface Pattern { pattern: string; leads: number; won: number; revenueCents: number; medianDays: number | null; medianSteps: number | null }
interface First { channel: string; leads: number; won: number; revenueCents: number; medianDays: number | null }
interface Landing { label: string; path: string; leads: number; won: number; revenueCents: number; channels: string[] }
interface Transition { from: string; to: string; n: number; won: number }
interface Report {
  start: string; end: string; sources: string[];
  totals: { deals: number; won: number; revenueCents: number; paidFirst: number; medianDays: number | null; medianTouches: number | null; multiTouch: number };
  patterns: Pattern[]; firstTouch: First[]; landings: Landing[]; transitions: Transition[]; lengths: { steps: number; leads: number; won: number }[];
}

const CH_COLOR: Record<string, string> = {
  "Meta Ads": "#4267B2", "Google Ads": "#34A853", Email: "#8e44ad", "Organic search": "#2a9d8f", Social: "#e76f51", Referral: "#b08968", Direct: "#6c757d", "Other paid": "#f4a261",
};
const usd = (c: number) => `$${Math.round(c / 100).toLocaleString()}`;
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((100 * n) / d)}%` : "—");
const days = (d: number | null) => (d == null ? "—" : d < 1 ? "<1d" : `${Math.round(d)}d`);

function Chip({ c }: { c: string }) {
  return <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 650, background: (CH_COLOR[c] ?? "#888") + "22", color: CH_COLOR[c] ?? "var(--text-2)", border: `1px solid ${(CH_COLOR[c] ?? "#888")}55` }}>{c}</span>;
}
function Path({ p }: { p: string }) {
  const parts = p.split(" → ");
  return <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>{parts.map((c, i) => <span key={i} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Chip c={c} />{i < parts.length - 1 && <span style={{ color: "var(--text-3)" }}>→</span>}</span>)}<span style={{ color: "var(--text-3)", fontSize: 12 }}>→ deal</span></span>;
}

export function JourneysView() {
  const [daysBack, setDaysBack] = useState(90);
  const [wonOnly, setWonOnly] = useState(false);
  const [source, setSource] = useState("");
  const [minSteps, setMinSteps] = useState(1);
  const [data, setData] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null); setErr(null);
    fetch(`/api/admin/analytics/journeys?days=${daysBack}&won=${wonOnly ? 1 : 0}&source=${encodeURIComponent(source)}&minSteps=${minSteps}`)
      .then((r) => r.json()).then((d) => (d.error ? setErr(d.error) : setData(d))).catch(() => setErr("failed to load"));
  }, [daysBack, wonOnly, source, minSteps]);

  const th: React.CSSProperties = { padding: "6px 8px", fontSize: 12, color: "var(--text-3)", textAlign: "right", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "7px 8px", fontSize: 13, textAlign: "right", borderTop: "1px solid var(--border-soft)", verticalAlign: "top" };
  const left: React.CSSProperties = { textAlign: "left" };
  const tile = (label: string, value: string, sub?: string) => (
    <div className="card" style={{ padding: "12px 14px", minWidth: 150 }}>
      <div style={{ fontSize: 12, color: "var(--text-3)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 750 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--text-2)" }}>{sub}</div>}
    </div>
  );

  return (
    <>
      <h2 style={{ margin: "0 0 4px" }}>🧭 Journeys</h2>
      <p className="viewsub" style={{ marginTop: 0 }}>
        How leads actually arrive: every ad click, email click and site visit we recorded for a contact, in order, up to the deal (and 30 days after). Consecutive visits from the same channel count as one step.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "10px 0 14px" }}>
        {[30, 90, 180, 365].map((d) => <button key={d} className={`btn ${daysBack === d ? "primary" : "ghost"}`} style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => setDaysBack(d)}>{d}d</button>)}
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={wonOnly} onChange={(e) => setWonOnly(e.target.checked)} /> won only</label>
        <select className="vmsel" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">any deal source</option>
          {(data?.sources ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="vmsel" value={minSteps} onChange={(e) => setMinSteps(Number(e.target.value))}>
          <option value={1}>any path length</option>
          <option value={2}>2+ channels</option>
          <option value={3}>3+ channels</option>
        </select>
      </div>

      {err && <div style={{ color: "var(--bad)" }}>{err}</div>}
      {!data && !err && <div className="viewsub">Loading…</div>}
      {data && (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
            {tile("Deals with a journey", data.totals.deals.toLocaleString(), `${data.start} → ${data.end}`)}
            {tile("Won", data.totals.won.toLocaleString(), `${pct(data.totals.won, data.totals.deals)} · ${usd(data.totals.revenueCents)}`)}
            {tile("Paid first touch", pct(data.totals.paidFirst, data.totals.deals), `${data.totals.paidFirst.toLocaleString()} deals`)}
            {tile("Multi-channel paths", pct(data.totals.multiTouch, data.totals.deals), `${data.totals.multiTouch.toLocaleString()} deals touched 2+ channels`)}
            {tile("Median first touch → deal", days(data.totals.medianDays), `median ${data.totals.medianTouches ?? "—"} visits before the deal`)}
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="panel-h">Most common paths</div>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr><th style={{ ...th, ...left }}>Path</th><th style={th}>Leads</th><th style={th}>Won</th><th style={th}>Win rate</th><th style={th}>Revenue</th><th style={th}>Median days</th><th style={th}>Visits</th></tr></thead>
              <tbody>
                {data.patterns.map((p) => (
                  <tr key={p.pattern}>
                    <td style={{ ...td, ...left }}><Path p={p.pattern} /></td>
                    <td style={td}>{p.leads}</td><td style={td}>{p.won}</td><td style={td}>{pct(p.won, p.leads)}</td><td style={td}>{usd(p.revenueCents)}</td><td style={td}>{days(p.medianDays)}</td><td style={td}>{p.medianSteps ?? "—"}</td>
                  </tr>
                ))}
                {data.patterns.length === 0 && <tr><td colSpan={7} style={{ ...td, ...left, color: "var(--text-3)" }}>No journeys in this window.</td></tr>}
              </tbody>
            </table>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16, marginBottom: 16 }}>
            <div className="card">
              <div className="panel-h">First touch channel</div>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr><th style={{ ...th, ...left }}>Channel</th><th style={th}>Leads</th><th style={th}>Won</th><th style={th}>Win rate</th><th style={th}>Revenue</th><th style={th}>Median days</th></tr></thead>
                <tbody>{data.firstTouch.map((f) => <tr key={f.channel}><td style={{ ...td, ...left }}><Chip c={f.channel} /></td><td style={td}>{f.leads}</td><td style={td}>{f.won}</td><td style={td}>{pct(f.won, f.leads)}</td><td style={td}>{usd(f.revenueCents)}</td><td style={td}>{days(f.medianDays)}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="card">
              <div className="panel-h">Path length</div>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr><th style={{ ...th, ...left }}>Channels in path</th><th style={th}>Leads</th><th style={th}>Won</th><th style={th}>Win rate</th></tr></thead>
                <tbody>{data.lengths.map((l) => <tr key={l.steps}><td style={{ ...td, ...left }}>{l.steps}{l.steps === 6 ? "+" : ""}</td><td style={td}>{l.leads}</td><td style={td}>{l.won}</td><td style={td}>{pct(l.won, l.leads)}</td></tr>)}</tbody>
              </table>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16, marginBottom: 16 }}>
            <div className="card">
              <div className="panel-h">First landing page</div>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr><th style={{ ...th, ...left }}>Page</th><th style={th}>Leads</th><th style={th}>Won</th><th style={th}>Win rate</th><th style={{ ...th, ...left }}>Arrived via</th></tr></thead>
                <tbody>{data.landings.map((l) => <tr key={l.path}><td style={{ ...td, ...left }} title={l.path}><b>{l.label}</b><div style={{ fontSize: 11.5, color: "var(--text-3)", fontFamily: "ui-monospace, monospace" }}>{l.path}</div></td><td style={td}>{l.leads}</td><td style={td}>{l.won}</td><td style={td}>{pct(l.won, l.leads)}</td><td style={{ ...td, ...left, color: "var(--text-2)", fontSize: 12 }}>{l.channels.join(" · ")}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="card">
              <div className="panel-h">What follows what</div>
              <p className="viewsub" style={{ marginTop: 0, fontSize: 12.5 }}>Step-to-step transitions across all paths. "Email → Meta Ads" = an email click followed by a Meta ad click.</p>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr><th style={{ ...th, ...left }}>From → To</th><th style={th}>Times</th><th style={th}>In won deals</th></tr></thead>
                <tbody>{data.transitions.map((t) => <tr key={`${t.from}|${t.to}`}><td style={{ ...td, ...left }}><Chip c={t.from} /> <span style={{ color: "var(--text-3)" }}>→</span> <Chip c={t.to} /></td><td style={td}>{t.n}</td><td style={td}>{t.won}</td></tr>)}</tbody>
              </table>
            </div>
          </div>

          <div className="viewsub" style={{ fontSize: 12.5 }}>
            Only contacts our website beacon has identified have a journey (about a third of deals). Ad clicks are recorded since Aug 25; organic and direct visits since Oct 7, and Klaviyo email clicks are identified on landing since Oct 9, so older windows under-count those channels. Revenue is the deal value on won deals.
          </div>
        </>
      )}
    </>
  );
}
