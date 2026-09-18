"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Channel {
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
  channels: Channel[];
  totals: { spendCents: number; newDeals: number; attributedDeals: number; blendedCacCents: number | null; wonDeals: number; wonValueCents: number };
}

const usd = (c: number | null) => (c == null ? "—" : `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const num = (n: number) => n.toLocaleString();
const roas = (rev: number, spend: number) => (spend > 0 ? `${(rev / spend).toFixed(2)}×` : "—");

const DAYS = [7, 14, 30, 90];
const CHAN_LABEL: Record<string, string> = { google: "🔍 Google", facebook: "📘 Meta", chatgpt: "🤖 ChatGPT" };
const CHAN_LINK: Record<string, string> = { google: "/analytics/google", facebook: "/analytics/meta" };

export function AnalyticsOverview() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    fetch(`/api/admin/ad-roi?days=${days}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch(() => setError("failed to load"));
  }, [days]);

  const paid = (data?.channels ?? []).filter((c) => c.spendCents > 0).sort((a, b) => b.spendCents - a.spendCents);
  const attrPct = data && data.totals.newDeals > 0 ? data.totals.attributedDeals / data.totals.newDeals : null;

  const stat = (label: string, value: string, hint?: string) => (
    <div className="card" style={{ padding: "12px 16px", minWidth: 130 }}>
      <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {hint && <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{hint}</div>}
    </div>
  );
  const th: React.CSSProperties = { textAlign: "right", padding: "7px 10px", fontSize: 12, color: "var(--text-3)", fontWeight: 600, whiteSpace: "nowrap" };
  const td: React.CSSProperties = { textAlign: "right", padding: "8px 10px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 className="viewtitle" style={{ margin: 0 }}>Analytics Overview</h2>
        <div style={{ display: "flex", gap: 4 }}>
          {DAYS.map((d) => (
            <button key={d} className={days === d ? "btn primary" : "btn ghost"} style={{ padding: "3px 12px", fontSize: 13 }} onClick={() => setDays(d)}>{d}d</button>
          ))}
        </div>
      </div>
      <div className="viewsub" style={{ marginBottom: 14 }}>Cross-channel spend & return · last {days} days · native Meta + Google feeds, first-party attribution</div>

      {error && <div className="viewsub" style={{ color: "var(--crit)" }}>Couldn’t load: {error}</div>}
      {!data && !error && <div className="viewsub">Loading…</div>}

      {data && (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
            {stat("Ad spend", usd(data.totals.spendCents))}
            {stat("New deals", num(data.totals.newDeals), `${data.totals.attributedDeals} attributed`)}
            {stat("Won", `${num(data.totals.wonDeals)} · ${usd(data.totals.wonValueCents)}`)}
            {stat("Blended ROAS", roas(data.totals.wonValueCents, data.totals.spendCents), "won value ÷ spend")}
            {stat("Blended CAC", usd(data.totals.blendedCacCents), "spend ÷ all new deals")}
            {stat("Attribution", attrPct == null ? "—" : `${(attrPct * 100).toFixed(0)}%`, "of deals matched to a click")}
          </div>

          <div className="card" style={{ padding: 0, overflowX: "auto", marginBottom: 14 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>Channel</th>
                  <th style={th}>Spend</th>
                  <th style={th}>Leads</th>
                  <th style={th}>CPL</th>
                  <th style={th}>Won</th>
                  <th style={th}>Won value</th>
                  <th style={th}>Cost / won</th>
                  <th style={th}>ROAS</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {paid.map((c) => (
                  <tr key={c.channel} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px 10px", fontWeight: 600 }}>{CHAN_LABEL[c.channel] ?? c.channel}</td>
                    <td style={td}>{usd(c.spendCents)}</td>
                    <td style={td}>{num(c.leads)}</td>
                    <td style={td}>{usd(c.cplCents)}</td>
                    <td style={td}>{num(c.wonDeals)}</td>
                    <td style={td}>{usd(c.wonValueCents)}</td>
                    <td style={td}>{usd(c.costPerWonCents)}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{roas(c.wonValueCents, c.spendCents)}</td>
                    <td style={{ ...td, padding: "8px 10px" }}>{CHAN_LINK[c.channel] && <Link href={CHAN_LINK[c.channel]} style={{ color: "var(--accent)" }}>details →</Link>}</td>
                  </tr>
                ))}
                {paid.length === 0 && <tr><td colSpan={9} style={{ padding: 16, color: "var(--text-3)" }}>No paid channel spend in this window.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="viewsub" style={{ fontSize: 12.5 }}>
            Channel CPL/ROAS use first-party attribution (~{attrPct == null ? "—" : `${(attrPct * 100).toFixed(0)}%`} coverage); blended figures divide by all new deals. For the full lead→deal funnel see <Link href="/ad-roi" style={{ color: "var(--accent)" }}>Ad ROI</Link>.
          </div>
        </>
      )}
    </>
  );
}
