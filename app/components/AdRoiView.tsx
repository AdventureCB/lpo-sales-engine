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

export function AdRoiView() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    fetch(`/api/admin/ad-roi?days=${days}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [days]);

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
