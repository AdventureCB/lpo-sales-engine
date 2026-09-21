"use client";

import { useEffect, useState } from "react";

interface Prev { spendCents: number; revenueCents: number; roas: number | null; leads: number; wonDeals: number }
interface Row {
  campaignId: string; name: string;
  spendCents: number; clicks: number; impressions: number;
  ctr: number | null; cpcCents: number | null; cpmCents: number | null;
  imprShare: number | null; lostIsBudget: number | null; lostIsRank: number | null;
  leads: number; wonDeals: number; revenueCents: number;
  roas: number | null; cplCents: number | null; cacCents: number | null;
  prev: Prev | null;
}
interface Totals { spendCents: number; clicks: number; impressions: number; ctr: number | null; cpcCents: number | null; cpmCents: number | null; leads: number; wonDeals: number; revenueCents: number; roas: number | null; cplCents: number | null; cacCents: number | null }
interface Report { channel: string; start: string; end: string; spanDays: number; compare: { start: string; end: string } | null; rows: Row[]; totals: Totals; prevTotals: Totals | null }

interface AdRow {
  adId: string; name: string; groupId: string | null; groupName: string | null;
  spendCents: number; clicks: number; impressions: number; ctr: number | null; cpcCents: number | null;
  convValueCents: number; conversions: number; platformRoas: number | null;
  leads: number; wonDeals: number; revenueCents: number; roas: number | null;
  prev: { spendCents: number; roas: number | null } | null;
}
interface AdsReport { groups: { groupId: string | null; groupName: string | null; spendCents: number; ads: AdRow[] }[]; totals: { spendCents: number; revenueCents: number; roas: number | null } }

const usd = (c: number | null) => (c == null ? "—" : `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const usd2 = (c: number | null) => (c == null ? "—" : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (r: number | null, d = 1) => (r == null ? "—" : `${(r * 100).toFixed(d)}%`);
const roasFmt = (r: number | null) => (r == null ? "—" : `${r.toFixed(2)}×`);
const num = (n: number) => n.toLocaleString();
const todayLocal = () => new Intl.DateTimeFormat("en-CA").format(new Date());

const DAYS = [7, 14, 30, 90];

/** Signed % change with color + arrow; higherIsBetter flips the color meaning. */
function Delta({ cur, prev, higherIsBetter = true }: { cur: number | null; prev: number | null | undefined; higherIsBetter?: boolean }) {
  if (cur == null || prev == null || prev === 0) return null;
  const chg = (cur - prev) / Math.abs(prev);
  if (!Number.isFinite(chg) || Math.abs(chg) < 0.0005) return <span style={{ fontSize: 11.5, color: "var(--text-3)" }}> · flat</span>;
  const good = higherIsBetter ? chg > 0 : chg < 0;
  return (
    <span style={{ fontSize: 11.5, color: good ? "#3a9d5d" : "#e0574a", fontWeight: 600 }}>
      {" "}{chg > 0 ? "▲" : "▼"}{Math.abs(chg * 100).toFixed(0)}%
    </span>
  );
}

export function CampaignAnalyticsView({ channel, title }: { channel: "google" | "meta"; title: string }) {
  const [days, setDays] = useState<number | null>(30);
  const [start, setStart] = useState(() => new Intl.DateTimeFormat("en-CA").format(new Date(Date.now() - 29 * 86_400_000)));
  const [end, setEnd] = useState(todayLocal);
  const [compare, setCompare] = useState(false);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Campaign → its ads (fetched on expand; keyed by campaign id, reset on range change).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ads, setAds] = useState<Record<string, AdsReport | "loading" | "error">>({});
  const isGoogle = channel === "google";

  const rangeQs = days != null ? `days=${days}` : `start=${start}&end=${end}`;

  useEffect(() => {
    setData(null);
    setError(null);
    setAds({});
    fetch(`/api/admin/analytics/campaigns?channel=${channel}&${rangeQs}&compare=${compare ? "prev" : ""}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch(() => setError("failed to load"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, days, start, end, compare]);

  const toggle = (campaignId: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(campaignId)) n.delete(campaignId);
      else n.add(campaignId);
      return n;
    });
    if (!ads[campaignId]) {
      setAds((a) => ({ ...a, [campaignId]: "loading" }));
      fetch(`/api/admin/analytics/ads?channel=${channel}&campaignId=${encodeURIComponent(campaignId)}&${rangeQs}&compare=${compare ? "prev" : ""}`)
        .then((r) => r.json())
        .then((d) => setAds((a) => ({ ...a, [campaignId]: d.error ? "error" : d })))
        .catch(() => setAds((a) => ({ ...a, [campaignId]: "error" })));
    }
  };

  const stat = (label: string, value: string, delta?: React.ReactNode, hint?: string) => (
    <div className="card" style={{ padding: "12px 16px", minWidth: 120 }}>
      <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}{delta}</div>
      {hint && <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{hint}</div>}
    </div>
  );
  const th: React.CSSProperties = { textAlign: "right", padding: "7px 9px", fontSize: 11.5, color: "var(--text-3)", fontWeight: 600, whiteSpace: "nowrap", position: "sticky", top: 0, background: "var(--surface-1)" };
  const td: React.CSSProperties = { textAlign: "right", padding: "7px 9px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  const tdSub: React.CSSProperties = { ...td, fontSize: 12.5, color: "var(--text-2)" };
  const isCols = isGoogle ? 3 : 0;
  const colCount = 11 + isCols;

  const pt = data?.prevTotals ?? null;

  const adRows = (campaignId: string) => {
    const a = ads[campaignId];
    if (!a || a === "loading") return <tr><td colSpan={colCount} style={{ padding: "8px 9px 8px 34px", color: "var(--text-3)", fontSize: 12.5 }}>Loading ads…</td></tr>;
    if (a === "error") return <tr><td colSpan={colCount} style={{ padding: "8px 9px 8px 34px", color: "var(--crit)", fontSize: 12.5 }}>Couldn’t load ads.</td></tr>;
    if (a.groups.length === 0) return <tr><td colSpan={colCount} style={{ padding: "8px 9px 8px 34px", color: "var(--text-3)", fontSize: 12.5 }}>No ad-level data in this window yet (populates from the next daily sync).</td></tr>;
    const groupLabel = isGoogle ? "Ad group" : "Ad set";
    return a.groups.flatMap((g) => [
      <tr key={`g:${g.groupId ?? "none"}`} style={{ background: "var(--surface-2)" }}>
        <td colSpan={colCount} style={{ padding: "5px 9px 5px 30px", fontSize: 12, fontWeight: 650, color: "var(--text-2)" }}>
          {groupLabel}: {g.groupName ?? g.groupId ?? "(none)"} <span style={{ fontWeight: 400, color: "var(--text-3)" }}>· {usd(g.spendCents)}</span>
        </td>
      </tr>,
      ...g.ads.map((ad) => (
        <tr key={`a:${ad.adId}`}>
          <td style={{ padding: "6px 9px 6px 44px", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, color: "var(--text-2)" }} title={`${ad.name} · ad ${ad.adId}`}>{ad.name}</td>
          <td style={tdSub}>{usd(ad.spendCents)}{compare && <Delta cur={ad.spendCents} prev={ad.prev?.spendCents} higherIsBetter={false} />}</td>
          <td style={tdSub}>{num(ad.impressions)}</td>
          <td style={tdSub}>{num(ad.clicks)}</td>
          <td style={tdSub}>{pct(ad.ctr, 2)}</td>
          <td style={tdSub}>{usd2(ad.cpcCents)}</td>
          {isGoogle && <td style={tdSub}></td>}
          {isGoogle && <td style={tdSub}></td>}
          {isGoogle && <td style={tdSub}></td>}
          <td style={tdSub}>{num(ad.leads)}</td>
          <td style={tdSub}>{num(ad.wonDeals)}</td>
          <td style={tdSub}>{usd(ad.revenueCents)}</td>
          <td style={{ ...tdSub, fontWeight: 600 }} title={ad.platformRoas != null ? `Platform-reported ROAS ${roasFmt(ad.platformRoas)}` : undefined}>
            {roasFmt(ad.roas)}{compare && <Delta cur={ad.roas} prev={ad.prev?.roas} />}
          </td>
        </tr>
      )),
    ]);
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 className="viewtitle" style={{ margin: 0 }}>{title}</h2>
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
        {data ? `${data.start} → ${data.end} (${data.spanDays}d)` : "…"}
        {data?.compare ? ` · vs ${data.compare.start} → ${data.compare.end}` : ""}
        {isGoogle ? " · impression share impression-weighted" : ""}
        {" · ROAS from first-party attribution · click ▸ on a campaign to see its ads"}
      </div>

      {error && <div className="viewsub" style={{ color: "var(--crit)" }}>Couldn’t load: {error}</div>}
      {!data && !error && <div className="viewsub">Loading…</div>}

      {data && (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
            {stat("Spend", usd(data.totals.spendCents), compare && <Delta cur={data.totals.spendCents} prev={pt?.spendCents} higherIsBetter={false} />)}
            {stat("Revenue", usd(data.totals.revenueCents), compare && <Delta cur={data.totals.revenueCents} prev={pt?.revenueCents} />, `${data.totals.wonDeals} won`)}
            {stat("ROAS", roasFmt(data.totals.roas), compare && <Delta cur={data.totals.roas} prev={pt?.roas} />, "revenue ÷ spend")}
            {stat("Leads", num(data.totals.leads), compare && <Delta cur={data.totals.leads} prev={pt?.leads} />, `CPL ${usd(data.totals.cplCents)}`)}
            {stat("Impressions", num(data.totals.impressions), compare && <Delta cur={data.totals.impressions} prev={pt?.impressions} />)}
            {stat("Clicks", num(data.totals.clicks), undefined, `CTR ${pct(data.totals.ctr, 2)} · CPC ${usd2(data.totals.cpcCents)}`)}
          </div>

          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: isGoogle ? 1100 : 860 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>Campaign</th>
                  <th style={th}>Spend</th>
                  <th style={th}>Impr.</th>
                  <th style={th}>Clicks</th>
                  <th style={th}>CTR</th>
                  <th style={th}>CPC</th>
                  {isGoogle && <th style={th} title="Search impression share">Impr. share</th>}
                  {isGoogle && <th style={th} title="Impressions lost to budget">Lost (bud)</th>}
                  {isGoogle && <th style={th} title="Impressions lost to Ad Rank">Lost (rank)</th>}
                  <th style={th}>Leads</th>
                  <th style={th}>Won</th>
                  <th style={th}>Revenue</th>
                  <th style={th}>ROAS</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const canExpand = r.campaignId !== "__unresolved__";
                  const open = expanded.has(r.campaignId);
                  return [
                    <tr key={r.campaignId} style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={{ padding: "7px 9px", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>
                        {canExpand ? (
                          <button
                            className="btn ghost"
                            style={{ padding: "0 6px", fontSize: 12, marginRight: 6, minWidth: 22 }}
                            onClick={() => toggle(r.campaignId)}
                            title={open ? "Hide ads" : "Show this campaign's ads"}
                            aria-expanded={open}
                          >
                            {open ? "▾" : "▸"}
                          </button>
                        ) : (
                          <span style={{ display: "inline-block", width: 28 }} />
                        )}
                        {r.name}
                      </td>
                      <td style={td}>{usd(r.spendCents)}{compare && <Delta cur={r.spendCents} prev={r.prev?.spendCents} higherIsBetter={false} />}</td>
                      <td style={td}>{num(r.impressions)}</td>
                      <td style={td}>{num(r.clicks)}</td>
                      <td style={td}>{pct(r.ctr, 2)}</td>
                      <td style={td}>{usd2(r.cpcCents)}</td>
                      {isGoogle && <td style={{ ...td, fontWeight: 600, color: r.imprShare == null ? "var(--text-3)" : r.imprShare < 0.3 ? "#e0574a" : r.imprShare > 0.7 ? "#3a9d5d" : "var(--text-1)" }}>{pct(r.imprShare)}</td>}
                      {isGoogle && <td style={td}>{pct(r.lostIsBudget)}</td>}
                      {isGoogle && <td style={td}>{pct(r.lostIsRank)}</td>}
                      <td style={td}>{num(r.leads)}</td>
                      <td style={td}>{num(r.wonDeals)}</td>
                      <td style={td}>{usd(r.revenueCents)}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{roasFmt(r.roas)}{compare && <Delta cur={r.roas} prev={r.prev?.roas} />}</td>
                    </tr>,
                    ...(open ? [<tr key={`x:${r.campaignId}`}><td colSpan={colCount} style={{ padding: 0 }}><table style={{ borderCollapse: "collapse", width: "100%" }}><tbody>{adRows(r.campaignId)}</tbody></table></td></tr>] : []),
                  ];
                })}
                {data.rows.length === 0 && (
                  <tr><td colSpan={colCount} style={{ padding: 16, color: "var(--text-3)" }}>No campaign data in this window.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="viewsub" style={{ marginTop: 10, fontSize: 12.5 }}>
            Leads/Won/Revenue/ROAS are attributed from first-party clicks{isGoogle ? " (Google clicks resolved to campaigns and ads via the click-view map)" : " (Meta campaign + ad ids on the click)"}.
            {isGoogle && " Impression share is blank where Google withholds it (low volume or non-Search campaigns)."}
            {" Ad rows hover-show the platform-reported ROAS."}
          </div>
        </>
      )}
    </>
  );
}
