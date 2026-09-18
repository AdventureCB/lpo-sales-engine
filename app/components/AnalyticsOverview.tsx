"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Prev { spendCents: number; convValueCents: number; platformRoas: number | null; revenueCents: number; firstPartyRoas: number | null; leads: number; wonDeals: number }
interface Chan extends Prev { channel: string; conversions: number; cplCents: number | null; cacCents: number | null; prev: Prev | null }
interface Totals { spendCents: number; convValueCents: number; platformRoas: number | null; leads: number; wonDeals: number; revenueCents: number; firstPartyRoas: number | null; cplCents: number | null; cacCents: number | null }
interface Report { start: string; end: string; spanDays: number; compare: { start: string; end: string } | null; channels: Chan[]; totals: Totals; prevTotals: Totals | null; trend: { day: string; byChannel: Record<string, number> }[] }

const usd = (c: number | null) => (c == null ? "—" : `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const roasFmt = (r: number | null) => (r == null ? "—" : `${r.toFixed(2)}×`);
const num = (n: number) => n.toLocaleString();
const todayLocal = () => new Intl.DateTimeFormat("en-CA").format(new Date());

const DAYS = [7, 14, 30, 90];
const CHAN_LABEL: Record<string, string> = { google: "🔍 Google", facebook: "📘 Meta", chatgpt: "🤖 ChatGPT" };
const CHAN_LINK: Record<string, string> = { google: "/analytics/google", facebook: "/analytics/meta" };
const CHAN_COLOR: Record<string, string> = { google: "#d98b2b", facebook: "#3b6fd6", chatgpt: "#59a869" };
const colorFor = (ch: string) => CHAN_COLOR[ch] ?? "#8a8f98";

function Delta({ cur, prev, higherIsBetter = true }: { cur: number | null; prev: number | null | undefined; higherIsBetter?: boolean }) {
  if (cur == null || prev == null || prev === 0) return null;
  const chg = (cur - prev) / Math.abs(prev);
  if (!Number.isFinite(chg) || Math.abs(chg) < 0.0005) return <span style={{ fontSize: 11.5, color: "var(--text-3)" }}> · flat</span>;
  const good = higherIsBetter ? chg > 0 : chg < 0;
  return <span style={{ fontSize: 11.5, color: good ? "#3a9d5d" : "#e0574a", fontWeight: 600 }}> {chg > 0 ? "▲" : "▼"}{Math.abs(chg * 100).toFixed(0)}%</span>;
}

function SpendTrend({ trend }: { trend: Report["trend"] }) {
  if (trend.length < 2) return null;
  const channels = [...new Set(trend.flatMap((d) => Object.keys(d.byChannel)))];
  const totals = trend.map((d) => channels.reduce((s, c) => s + (d.byChannel[c] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const W = 760, H = 150, pad = 4;
  const bw = (W - pad * 2) / trend.length;
  return (
    <div className="card" style={{ padding: "14px 16px", marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <div className="panel-h" style={{ margin: 0 }}>Daily spend by channel</div>
        <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
          {channels.map((c) => (
            <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: colorFor(c) }} /> {CHAN_LABEL[c] ?? c}
            </span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 150, marginTop: 8, overflow: "visible" }} preserveAspectRatio="none">
        {trend.map((d, i) => {
          let y = H;
          const x = pad + i * bw;
          return channels.map((c) => {
            const v = d.byChannel[c] ?? 0;
            if (v <= 0) return null;
            const h = ((H - 2) * v) / max;
            y -= h;
            return <rect key={c} x={x + 1} y={y} width={Math.max(1, bw - 2)} height={h} fill={colorFor(c)} rx={1}><title>{`${d.day} · ${CHAN_LABEL[c] ?? c}: ${usd(v)}`}</title></rect>;
          });
        })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>
        <span>{trend[0].day}</span><span>{trend[trend.length - 1].day}</span>
      </div>
    </div>
  );
}

export function AnalyticsOverview() {
  const [days, setDays] = useState<number | null>(30);
  const [start, setStart] = useState(() => new Intl.DateTimeFormat("en-CA").format(new Date(Date.now() - 29 * 86_400_000)));
  const [end, setEnd] = useState(todayLocal);
  const [compare, setCompare] = useState(false);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    const range = days != null ? `days=${days}` : `start=${start}&end=${end}`;
    fetch(`/api/admin/analytics/overview?${range}&compare=${compare ? "prev" : ""}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch(() => setError("failed to load"));
  }, [days, start, end, compare]);

  const pt = data?.prevTotals ?? null;
  const stat = (label: string, value: string, delta?: React.ReactNode, hint?: string) => (
    <div className="card" style={{ padding: "12px 16px", minWidth: 130 }}>
      <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}{delta}</div>
      {hint && <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{hint}</div>}
    </div>
  );
  const th: React.CSSProperties = { textAlign: "right", padding: "7px 10px", fontSize: 11.5, color: "var(--text-3)", fontWeight: 600, whiteSpace: "nowrap" };
  const td: React.CSSProperties = { textAlign: "right", padding: "8px 10px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 className="viewtitle" style={{ margin: 0 }}>Analytics Overview</h2>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {DAYS.map((d) => (
            <button key={d} className={days === d ? "btn primary" : "btn ghost"} style={{ padding: "3px 12px", fontSize: 13 }} onClick={() => setDays(d)}>{d}d</button>
          ))}
          <button className={days == null ? "btn primary" : "btn ghost"} style={{ padding: "3px 12px", fontSize: 13 }} onClick={() => setDays(null)}>Custom</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "8px 0 4px" }}>
        {days == null && (
          <>
            <input type="date" className="vmsel" value={start} max={end} onChange={(e) => setStart(e.target.value)} style={{ width: 150 }} />
            <span style={{ color: "var(--text-3)" }}>→</span>
            <input type="date" className="vmsel" value={end} min={start} max={todayLocal()} onChange={(e) => setEnd(e.target.value)} style={{ width: 150 }} />
          </>
        )}
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare to previous period
        </label>
      </div>
      <div className="viewsub" style={{ marginBottom: 14 }}>
        {data ? `${data.start} → ${data.end} (${data.spanDays}d)` : "…"}{data?.compare ? ` · vs ${data.compare.start} → ${data.compare.end}` : ""} · native Meta + Google · first-party attribution
      </div>

      {error && <div className="viewsub" style={{ color: "var(--crit)" }}>Couldn’t load: {error}</div>}
      {!data && !error && <div className="viewsub">Loading…</div>}

      {data && (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
            {stat("Ad spend", usd(data.totals.spendCents), compare && <Delta cur={data.totals.spendCents} prev={pt?.spendCents} higherIsBetter={false} />)}
            {stat("Won revenue", usd(data.totals.revenueCents), compare && <Delta cur={data.totals.revenueCents} prev={pt?.revenueCents} />, `${data.totals.wonDeals} won`)}
            {stat("CRM ROAS", roasFmt(data.totals.firstPartyRoas), compare && <Delta cur={data.totals.firstPartyRoas} prev={pt?.firstPartyRoas} />, "won value ÷ spend")}
            {stat("Platform ROAS", roasFmt(data.totals.platformRoas), compare && <Delta cur={data.totals.platformRoas} prev={pt?.platformRoas} />, "what Google/Meta report")}
            {stat("Leads", num(data.totals.leads), compare && <Delta cur={data.totals.leads} prev={pt?.leads} />, `CPL ${usd(data.totals.cplCents)}`)}
          </div>

          <SpendTrend trend={data.trend} />

          <div className="card" style={{ padding: 0, overflowX: "auto", marginBottom: 12 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 820 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>Channel</th>
                  <th style={th}>Spend</th>
                  <th style={th} title="What the platform's own conversion tracking reports">Platform ROAS</th>
                  <th style={th}>Leads</th>
                  <th style={th}>CPL</th>
                  <th style={th}>Won</th>
                  <th style={th}>Won value</th>
                  <th style={th} title="Won CRM revenue ÷ spend (first-party)">CRM ROAS</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {data.channels.map((c) => (
                  <tr key={c.channel} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px 10px", fontWeight: 600 }}>{CHAN_LABEL[c.channel] ?? c.channel}</td>
                    <td style={td}>{usd(c.spendCents)}{compare && <Delta cur={c.spendCents} prev={c.prev?.spendCents} higherIsBetter={false} />}</td>
                    <td style={td}>{roasFmt(c.platformRoas)}{compare && <Delta cur={c.platformRoas} prev={c.prev?.platformRoas} />}</td>
                    <td style={td}>{num(c.leads)}</td>
                    <td style={td}>{usd(c.cplCents)}</td>
                    <td style={td}>{num(c.wonDeals)}</td>
                    <td style={td}>{usd(c.revenueCents)}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{roasFmt(c.firstPartyRoas)}{compare && <Delta cur={c.firstPartyRoas} prev={c.prev?.firstPartyRoas} />}</td>
                    <td style={{ ...td, padding: "8px 10px" }}>{CHAN_LINK[c.channel] && <Link href={CHAN_LINK[c.channel]} style={{ color: "var(--accent)" }}>details →</Link>}</td>
                  </tr>
                ))}
                {data.channels.length === 0 && <tr><td colSpan={9} style={{ padding: 16, color: "var(--text-3)" }}>No channel activity in this window.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="viewsub" style={{ fontSize: 12.5 }}>
            <b>Platform ROAS</b> is what Google/Meta&rsquo;s own conversion tracking reports; <b>CRM ROAS</b> is won-deal revenue attributed to clicks in your CRM. They differ by attribution window and what counts as a &ldquo;win&rdquo; — the gap is expected. Full lead→deal funnel on <Link href="/ad-roi" style={{ color: "var(--accent)" }}>Ad ROI</Link>.
          </div>
        </>
      )}
    </>
  );
}
