"use client";

import { useEffect, useState } from "react";

interface Row {
  campaignId: string;
  name: string;
  spendCents: number;
  clicks: number;
  impressions: number;
  ctr: number | null;
  cpcCents: number | null;
  cpmCents: number | null;
  imprShare: number | null;
  lostIsBudget: number | null;
  lostIsRank: number | null;
}
interface Report {
  channel: string;
  days: number;
  rows: Row[];
  totals: { spendCents: number; clicks: number; impressions: number; ctr: number | null; cpcCents: number | null; cpmCents: number | null };
}

const usd = (c: number | null) => (c == null ? "—" : `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const usd2 = (c: number | null) => (c == null ? "—" : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (r: number | null, d = 1) => (r == null ? "—" : `${(r * 100).toFixed(d)}%`);
const num = (n: number) => n.toLocaleString();

const DAYS = [7, 14, 30, 90];

export function CampaignAnalyticsView({ channel, title }: { channel: "google" | "meta"; title: string }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isGoogle = channel === "google";

  useEffect(() => {
    setData(null);
    setError(null);
    fetch(`/api/admin/analytics/campaigns?channel=${channel}&days=${days}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch(() => setError("failed to load"));
  }, [channel, days]);

  const stat = (label: string, value: string) => (
    <div className="card" style={{ padding: "12px 16px", minWidth: 120 }}>
      <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );

  const th: React.CSSProperties = { textAlign: "right", padding: "7px 10px", fontSize: 12, color: "var(--text-3)", fontWeight: 600, whiteSpace: "nowrap", position: "sticky", top: 0, background: "var(--surface-1)" };
  const td: React.CSSProperties = { textAlign: "right", padding: "7px 10px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 className="viewtitle" style={{ margin: 0 }}>{title}</h2>
        <div style={{ display: "flex", gap: 4 }}>
          {DAYS.map((d) => (
            <button
              key={d}
              className={days === d ? "btn primary" : "btn ghost"}
              style={{ padding: "3px 12px", fontSize: 13 }}
              onClick={() => setDays(d)}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>
      <div className="viewsub" style={{ marginBottom: 14 }}>
        Campaign performance · last {days} days · spend/clicks/impressions from the native{" "}
        {isGoogle ? "Google Ads" : "Meta"} feed
        {isGoogle ? " · impression share is impression-weighted over the window" : ""}
      </div>

      {error && <div className="viewsub" style={{ color: "var(--crit)" }}>Couldn’t load: {error}</div>}
      {!data && !error && <div className="viewsub">Loading…</div>}

      {data && (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
            {stat("Spend", usd(data.totals.spendCents))}
            {stat("Impressions", num(data.totals.impressions))}
            {stat("Clicks", num(data.totals.clicks))}
            {stat("CTR", pct(data.totals.ctr, 2))}
            {stat("Avg CPC", usd2(data.totals.cpcCents))}
            {stat("CPM", usd2(data.totals.cpmCents))}
          </div>

          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: isGoogle ? 900 : 640 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>Campaign</th>
                  <th style={th}>Spend</th>
                  <th style={th}>Impr.</th>
                  <th style={th}>Clicks</th>
                  <th style={th}>CTR</th>
                  <th style={th}>CPC</th>
                  <th style={th}>CPM</th>
                  {isGoogle && <th style={th} title="Search impression share — how often your ads showed vs. total eligible">Impr. share</th>}
                  {isGoogle && <th style={th} title="Share of impressions lost because budget was too low">Lost (budget)</th>}
                  {isGoogle && <th style={th} title="Share of impressions lost to Ad Rank (bid/quality)">Lost (rank)</th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.campaignId} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "7px 10px", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>{r.name}</td>
                    <td style={td}>{usd(r.spendCents)}</td>
                    <td style={td}>{num(r.impressions)}</td>
                    <td style={td}>{num(r.clicks)}</td>
                    <td style={td}>{pct(r.ctr, 2)}</td>
                    <td style={td}>{usd2(r.cpcCents)}</td>
                    <td style={td}>{usd2(r.cpmCents)}</td>
                    {isGoogle && <td style={{ ...td, fontWeight: 600, color: r.imprShare == null ? "var(--text-3)" : r.imprShare < 0.3 ? "#e0574a" : r.imprShare > 0.7 ? "#3a9d5d" : "var(--text-1)" }}>{pct(r.imprShare)}</td>}
                    {isGoogle && <td style={td}>{pct(r.lostIsBudget)}</td>}
                    {isGoogle && <td style={td}>{pct(r.lostIsRank)}</td>}
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr><td colSpan={isGoogle ? 10 : 7} style={{ padding: 16, color: "var(--text-3)" }}>No campaign data in this window.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {isGoogle && (
            <div className="viewsub" style={{ marginTop: 10, fontSize: 12.5 }}>
              Impression share is blank for campaigns Google withholds it on (very low volume, or non-Search types like Performance Max / Display).
            </div>
          )}
        </>
      )}
    </>
  );
}
