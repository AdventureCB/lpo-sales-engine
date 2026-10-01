"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Admin revenue analytics: net revenue (never shipping or tax) for any
 * period vs any comparison period, with collections toggled in/out, orders
 * over a threshold deduped by customer, and revenue given away to discounts.
 * Data = the local Shopify order mirror (shop_orders / shop_order_lines).
 */

interface Series { bucket: string; gross: number; discounts: number; depositCredits: number; returns: number; net: number; orders: number }
interface BigCustomer { ckey: string; customer_name: string | null; email: string | null; orders: number; net: number; first_at: string; last_at: string; order_names: string[] }
interface Report {
  totals: { gross: number; discounts: number; depositCredits: number; returns: number; net: number; orders: number; units: number };
  big: { orders: number; customers: number; list: BigCustomer[] };
  series: Series[];
  discounts: { label: string; cents: number; orders: number }[];
}
interface Collection { id: number; title: string; handle: string | null; products_count: number | null; rule_based: boolean }
interface GoalMonth {
  bucket: string; future: boolean;
  lastYear: number; goal: number | null;
  twoYearsAgo: number | null; twoYearsAgoScaled: number | null; base2: number; normalized: number | null;
}
interface Goal {
  horizon: number; ratio: number | null; scale: number | null;
  periodNet: number; compareNet: number; compare2Net: number; compare2From: string; compare2To: string;
  months: GoalMonth[];
}
const NORMALIZED_COLOR = "#e0b341";
interface CvRow { month: string; purchases: number; totalCents: number; avgCents: number; medianCents: number }
interface SrcRow { month: string; sales: number; salesCents: number; organic: number; organicCents: number; sigDraft: number; sigRepcode: number; sigCrm: number }
interface KlavRow { month: string; allOrders: number; allCents: number; organicOrders: number; organicCents: number; clickOrders: number; clickCents: number; openOrders: number; openCents: number }
const KLAVIYO_COLOR = "#2bb673";
const KLAVIYO_SOFT = "#8fd4b3";
const AVG_SALE_CENTS = 1_200_000; // Kyle's working average camper sale, for the "≈ campers" readout
const YEAR_COLORS = ["var(--accent)", "var(--accent-2)", "#7aa7d9"]; // current year first
interface Health {
  monthsExcl: number; avgExcl: number | null;
  monthsIncl: number; avgIncl: number | null;
  includesCurrent: boolean; mtd: number | null; mtdMonth: string | null; dayOfMonth: number; daysInMonth: number;
  bands: { unhealthyBelow: number; okBelow: number; target: number };
}
interface Payload {
  a: Report | null;
  b: Report | null;
  goal: Goal | null;
  health: Health | null;
  customerValue: { gapDays: number; rows: CvRow[] } | null;
  purchaseSource: { gapDays: number; rows: SrcRow[] } | null;
  klaviyo: { windowDays: number; coverageFrom: string | null; rows: KlavRow[] } | null;
  bucket: string;
  threshold: number;
  collections: Collection[];
  selected: number[];
  unmatched: boolean;
  sync: {
    orders: number;
    oldestOrderAt: string | null;
    done?: boolean;
    lastFullAt?: string;
    lastIncrementalAt?: string;
    catalogAt?: string;
    catalogError?: string | null;
    ordersScanned?: number;
    configured: boolean;
  };
}

type Compare = "yoy" | "prior" | "custom";
type Bucket = "day" | "week" | "month";
const LS_KEY = "rev_prefs_v1";

const usd = (c: number | null | undefined, opts: { compact?: boolean } = {}) => {
  if (c == null) return "—";
  const v = c / 100;
  if (opts.compact && Math.abs(v) >= 100000) return `$${(v / 1000).toFixed(0)}k`;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
};
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s: string, n: number) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const addYears = (s: string, n: number) => { const d = parse(s); d.setFullYear(d.getFullYear() + n); return ymd(d); };
const dayCount = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000) + 1;
const fmtDate = (s: string) => parse(s.slice(0, 10)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtBucket = (s: string, bucket: Bucket) => {
  const d = parse(s.slice(0, 10));
  if (bucket === "month") return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

function presets(today: Date) {
  const t = ymd(today);
  const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
  const six = startOfMonth(new Date(today.getFullYear(), today.getMonth() - 5, 1));
  const twelve = startOfMonth(new Date(today.getFullYear(), today.getMonth() - 11, 1));
  return [
    { key: "6m", label: "Last 6 months vs same period last year", from: ymd(six), to: t, compare: "yoy" as Compare, bucket: "month" as Bucket },
    { key: "12m", label: "Last 12 months vs prior 12", from: ymd(twelve), to: t, compare: "prior" as Compare, bucket: "month" as Bucket },
    { key: "ytd", label: "Year to date vs last year", from: `${today.getFullYear()}-01-01`, to: t, compare: "yoy" as Compare, bucket: "month" as Bucket },
    { key: "mtd", label: "Month to date vs last year", from: ymd(startOfMonth(today)), to: t, compare: "yoy" as Compare, bucket: "day" as Bucket },
    { key: "30d", label: "Last 30 days vs prior 30", from: addDays(t, -29), to: t, compare: "prior" as Compare, bucket: "day" as Bucket },
    { key: "90d", label: "Last 90 days vs prior 90", from: addDays(t, -89), to: t, compare: "prior" as Compare, bucket: "week" as Bucket },
  ];
}

function derivedCompare(from: string, to: string, mode: Compare): [string, string] {
  if (mode === "yoy") return [addYears(from, -1), addYears(to, -1)];
  const n = dayCount(from, to);
  return [addDays(from, -n), addDays(to, -n)];
}

export function RevenueView() {
  const today = useMemo(() => new Date(), []);
  const PRESETS = useMemo(() => presets(today), [today]);
  const [from, setFrom] = useState(PRESETS[0].from);
  const [to, setTo] = useState(PRESETS[0].to);
  const [compare, setCompare] = useState<Compare>("yoy");
  const [cfrom, setCfrom] = useState(() => derivedCompare(PRESETS[0].from, PRESETS[0].to, "yoy")[0]);
  const [cto, setCto] = useState(() => derivedCompare(PRESETS[0].from, PRESETS[0].to, "yoy")[1]);
  const [bucket, setBucket] = useState<Bucket>("month");
  const [thresholdUsd, setThresholdUsd] = useState(5000);
  const [selected, setSelected] = useState<number[] | "all">("all");
  const [unmatched, setUnmatched] = useState(true);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [showBig, setShowBig] = useState<"a" | "b">("a");
  const [srcMode, setSrcMode] = useState<"count" | "value">("count");
  const [kwin, setKwin] = useState<1 | 3 | 5 | 7 | 14>(5);
  const [showCollections, setShowCollections] = useState(false);

  // Per-viewer preferences (collections + threshold) survive reloads.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (Array.isArray(p.selected)) setSelected(p.selected);
        if (typeof p.unmatched === "boolean") setUnmatched(p.unmatched);
        if (typeof p.thresholdUsd === "number") setThresholdUsd(p.thresholdUsd);
      }
    } catch {}
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try { localStorage.setItem(LS_KEY, JSON.stringify({ selected, unmatched, thresholdUsd })); } catch {}
  }, [selected, unmatched, thresholdUsd, prefsLoaded]);

  useEffect(() => {
    if (compare === "custom") return;
    const [f, t] = derivedCompare(from, to, compare);
    setCfrom(f);
    setCto(t);
  }, [from, to, compare]);

  // Each report takes a second or two; toggling chips in a row can make
  // responses land out of order, so only the newest request may paint and
  // superseded ones are aborted.
  const reqSeq = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (!prefsLoaded) return;
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ from, to, cfrom, cto, bucket, threshold: String(Math.round(thresholdUsd * 100)), unmatched: unmatched ? "1" : "0", kwin: String(kwin) });
    if (selected !== "all") q.set("collections", selected.join(","));
    try {
      const r = await fetch(`/api/admin/revenue?${q}`, { signal: ctrl.signal, cache: "no-store" });
      const j = await r.json();
      if (seq !== reqSeq.current) return;
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setData(j);
    } catch (e: any) {
      if (e?.name === "AbortError" || seq !== reqSeq.current) return;
      setError(String(e?.message ?? e));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [from, to, cfrom, cto, bucket, thresholdUsd, unmatched, selected, prefsLoaded, kwin]);

  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setFrom(p.from); setTo(p.to); setCompare(p.compare); setBucket(p.bucket);
  };

  const runSync = async (what: "incremental" | "full" | "catalog") => {
    setSyncing(what);
    setSyncMsg(null);
    try {
      const r = await fetch(`/api/admin/revenue?what=${what}`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || j.ok === false) throw new Error(j.error ?? r.statusText);
      setSyncMsg(
        what === "catalog"
          ? `Catalog synced: ${j.collections} collections, ${j.products} products.`
          : `${j.scanned} orders updated${j.done === false ? " — backfill still in progress, run again to continue" : ""}.`
      );
      await load();
    } catch (e: any) {
      setSyncMsg(`Sync failed: ${String(e?.message ?? e)}`);
    } finally {
      setSyncing(null);
    }
  };

  const cols = data?.collections ?? [];
  const selectedSet = useMemo(() => new Set(selected === "all" ? cols.map((c) => c.id) : selected), [selected, cols]);
  const toggleCol = (id: number) => {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next.size === cols.length ? "all" : Array.from(next));
  };

  const a = data?.a ?? null;
  const b = data?.b ?? null;
  const delta = (x: number | undefined, y: number | undefined) => {
    if (x == null || y == null) return null;
    if (y === 0) return x === 0 ? 0 : null;
    return ((x - y) / Math.abs(y)) * 100;
  };
  const DeltaTag = ({ x, y, invert }: { x?: number; y?: number; invert?: boolean }) => {
    const d = delta(x, y);
    if (d == null) return <span style={{ color: "var(--text-3)" }}>vs {y == null ? "—" : "0"}</span>;
    const good = invert ? d <= 0 : d >= 0;
    return (
      <span style={{ color: good ? "var(--good)" : "var(--crit)", fontWeight: 700 }}>
        {d >= 0 ? "▲" : "▼"} {Math.abs(d).toFixed(1)}%
      </span>
    );
  };
  const aov = (r: Report | null) => (r && r.totals.orders > 0 ? Math.round(r.totals.net / r.totals.orders) : null);
  const discountRate = (r: Report | null) => (r && r.totals.gross > 0 ? (r.totals.discounts / r.totals.gross) * 100 : null);

  const tile = (label: string, va: string, vb: string, d: React.ReactNode, sub?: string) => (
    <div className="stat-tile">
      <div className="n">{va}</div>
      <div className="l">{label}</div>
      <div className="d">{d} · prior {vb}{sub ? ` · ${sub}` : ""}</div>
    </div>
  );

  const bigList = (showBig === "a" ? a : b)?.big.list ?? [];
  const goalByMonth = useMemo(() => {
    const m = new Map<string, GoalMonth>();
    for (const g of data?.goal?.months ?? []) m.set(g.bucket.slice(0, 7), g);
    return m;
  }, [data?.goal]);
  const cvRows = data?.customerValue?.rows ?? [];
  const cvYears = useMemo(() => {
    const ys = Array.from(new Set(cvRows.map((r) => r.month.slice(0, 4)))).sort().reverse();
    return ys.length ? ys : [String(new Date().getFullYear())];
  }, [cvRows]);
  const cvByKey = useMemo(() => new Map(cvRows.map((r) => [r.month.slice(0, 7), r])), [cvRows]);
  const futureGoals = (data?.goal?.months ?? []).filter((g) => g.future && g.goal != null);
  const nextGoal = futureGoals[0] ?? null;
  const laterGoals = futureGoals.slice(1);
  const periodLabel = (f: string, t: string) => `${fmtDate(f)} – ${fmtDate(t)}`;
  const inputStyle: React.CSSProperties = { background: "var(--surface-2)", color: "var(--text-1)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 9px", fontSize: 13, fontVariantNumeric: "tabular-nums" };

  return (
    <div>
      <h1 className="viewtitle">💵 Revenue</h1>
      <p className="viewsub">Net revenue from Shopify orders — line items after discounts and refunds. Shipping and sales tax are never included. Unpaid, voided and test orders are out (including staff checkouts on a 100% test code); cancellations and refunds count as returns on the day they happen.</p>

      <div className="card" style={{ padding: "14px 18px", marginTop: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {PRESETS.map((p) => {
            const active = p.from === from && p.to === to && p.compare === compare;
            return (
              <button key={p.key} className={`btn ${active ? "primary" : "ghost"}`} style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => applyPreset(p)}>
                {p.label}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-end" }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-3)" }}>
            Period
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} style={inputStyle} />
              <span>→</span>
              <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} style={inputStyle} />
            </span>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-3)" }}>
            Compare to
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select value={compare} onChange={(e) => setCompare(e.target.value as Compare)} style={inputStyle}>
                <option value="yoy">Same period last year</option>
                <option value="prior">Prior period</option>
                <option value="custom">Custom</option>
              </select>
              <input type="date" value={cfrom} max={cto} disabled={compare !== "custom"} onChange={(e) => e.target.value && setCfrom(e.target.value)} style={{ ...inputStyle, opacity: compare === "custom" ? 1 : 0.6 }} />
              <span>→</span>
              <input type="date" value={cto} min={cfrom} disabled={compare !== "custom"} onChange={(e) => e.target.value && setCto(e.target.value)} style={{ ...inputStyle, opacity: compare === "custom" ? 1 : 0.6 }} />
            </span>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-3)" }}>
            Group by
            <select value={bucket} onChange={(e) => setBucket(e.target.value as Bucket)} style={inputStyle}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-3)" }}>
            Big-order threshold ($)
            <input type="number" min={0} step={500} value={thresholdUsd} onChange={(e) => setThresholdUsd(Math.max(0, Number(e.target.value) || 0))} style={{ ...inputStyle, width: 110 }} />
          </label>
          <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 12.5 }} onClick={() => setShowCollections((v) => !v)}>
            🗂 Collections: {selected === "all" ? "all" : `${selectedSet.size} of ${cols.length}`}{unmatched ? "" : " · no uncategorized"} {showCollections ? "▴" : "▾"}
          </button>
        </div>

        {showCollections && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-soft)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, fontSize: 12.5 }}>
              <button className="btn ghost" style={{ padding: "3px 9px", fontSize: 12 }} onClick={() => setSelected("all")}>All</button>
              <button className="btn ghost" style={{ padding: "3px 9px", fontSize: 12 }} onClick={() => setSelected([])}>None</button>
              <label style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={unmatched} onChange={(e) => setUnmatched(e.target.checked)} />
                Include lines with no collection (custom / unmatched products)
              </label>
              <span style={{ color: "var(--text-3)", marginLeft: "auto" }}>A product in several collections counts once when any of them is on.</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {cols.map((c) => {
                const on = selectedSet.has(c.id);
                return (
                  <button
                    key={c.id}
                    className="chip"
                    onClick={() => toggleCol(c.id)}
                    title={`${c.products_count ?? "?"} products${c.rule_based ? " · automated collection" : ""}`}
                    style={{
                      cursor: "pointer",
                      border: "1px solid " + (on ? "var(--accent)" : "var(--border)"),
                      background: on ? "var(--accent-soft)" : "transparent",
                      color: on ? "var(--text-1)" : "var(--text-3)",
                    }}
                  >
                    {on ? "✓" : "○"} {c.title}
                    <span style={{ opacity: 0.6, fontWeight: 500 }}>{c.products_count ?? ""}</span>
                  </button>
                );
              })}
              {cols.length === 0 && <span style={{ color: "var(--text-3)", fontSize: 12.5 }}>No collections synced yet.</span>}
            </div>
          </div>
        )}
      </div>

      {error && <p className="viewsub" style={{ color: "var(--crit)" }}>{error}</p>}
      {!data && !error && <p className="viewsub">Loading…</p>}

      {a && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 16, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 13, color: "var(--text-2)" }}>
              <b style={{ color: "var(--text-1)" }}>{periodLabel(from, to)}</b>
              <span style={{ color: "var(--text-3)" }}> vs {periodLabel(cfrom, cto)}{loading ? " · updating…" : ""}</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>{a.totals.units.toLocaleString()} units · {a.totals.orders.toLocaleString()} orders</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginTop: 10 }}>
            {tile("Net revenue", usd(a.totals.net), usd(b?.totals.net), <DeltaTag x={a.totals.net} y={b?.totals.net} />)}
            {tile("Gross sales", usd(a.totals.gross), usd(b?.totals.gross), <DeltaTag x={a.totals.gross} y={b?.totals.gross} />, "before discounts")}
            {tile("Lost to discounts", usd(a.totals.discounts), usd(b?.totals.discounts), <DeltaTag x={a.totals.discounts} y={b?.totals.discounts} invert />, `${discountRate(a) != null ? `${discountRate(a)!.toFixed(1)}% of gross` : ""}${a.totals.depositCredits ? ` · excludes ${usd(a.totals.depositCredits)} deposit credits` : ""}`)}
            {tile("Returns", usd(a.totals.returns), usd(b?.totals.returns), <DeltaTag x={a.totals.returns} y={b?.totals.returns} invert />)}
            {tile("Orders", a.totals.orders.toLocaleString(), (b?.totals.orders ?? 0).toLocaleString(), <DeltaTag x={a.totals.orders} y={b?.totals.orders} />)}
            {tile("Avg order", usd(aov(a)), usd(aov(b)), <DeltaTag x={aov(a) ?? undefined} y={aov(b) ?? undefined} />, "net ÷ orders")}
            {tile(`Orders > ${usd(thresholdUsd * 100)}`, a.big.orders.toLocaleString(), (b?.big.orders ?? 0).toLocaleString(), <DeltaTag x={a.big.orders} y={b?.big.orders} />)}
            {tile("Customers > threshold", a.big.customers.toLocaleString(), (b?.big.customers ?? 0).toLocaleString(), <DeltaTag x={a.big.customers} y={b?.big.customers} />, "deduped by name")}
          </div>

          {data?.health && (
            <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontWeight: 750 }}>Monthly revenue health</div>
                <div style={{ fontSize: 12, color: "var(--text-3)", display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--crit)", borderRadius: 2, marginRight: 5 }} />under {usd(data.health.bands.unhealthyBelow, { compact: true })} unhealthy</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: NORMALIZED_COLOR, borderRadius: 2, marginRight: 5 }} />to {usd(data.health.bands.okBelow, { compact: true })} ok</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--good)", borderRadius: 2, marginRight: 5 }} />above optimal</span>
                  <span>◆ target {usd(data.health.bands.target, { compact: true })}</span>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 18, marginTop: 8 }}>
                <Gauge
                  value={data.health.avgExcl}
                  bands={data.health.bands}
                  title="Average per month"
                  sub={data.health.monthsExcl ? `${data.health.monthsExcl} closed month${data.health.monthsExcl === 1 ? "" : "s"} in ${periodLabel(from, to)}, current month excluded` : "No closed months in this period"}
                />
                <Gauge
                  value={data.health.includesCurrent ? data.health.avgIncl : data.health.avgExcl}
                  bands={data.health.bands}
                  title="With month to date"
                  sub={
                    data.health.includesCurrent && data.health.mtdMonth
                      ? `${fmtBucket(data.health.mtdMonth, "month")} so far ${usd(data.health.mtd)} (day ${data.health.dayOfMonth} of ${data.health.daysInMonth}) → ${data.health.avgIncl != null && data.health.avgExcl != null ? `${data.health.avgIncl >= data.health.avgExcl ? "lifts" : "drags"} the average by ${usd(Math.abs(data.health.avgIncl - data.health.avgExcl))}` : "—"}`
                      : "Period does not include the current month"
                  }
                  muted={!data.health.includesCurrent}
                />
              </div>
            </div>
          )}

          <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontWeight: 750 }}>Net revenue by {bucket}</div>
              <div style={{ fontSize: 12, color: "var(--text-3)", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                <span><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--accent)", borderRadius: 2, marginRight: 5 }} />{periodLabel(from, to)}</span>
                <span><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--accent-2)", borderRadius: 2, marginRight: 5 }} />{periodLabel(cfrom, cto)}</span>
                {bucket === "month" && data?.goal && (
                  <>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ display: "inline-block", width: 14, height: 0, borderTop: "2px dashed var(--good)" }} />
                      Goal = last year&apos;s month × {data.goal.ratio != null ? data.goal.ratio.toFixed(3) : "—"}
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ display: "inline-block", width: 14, height: 0, borderTop: `2px dashed ${NORMALIZED_COLOR}` }} />
                      Normalized = avg(last year, 2 yrs ago) × {data.goal.ratio != null ? data.goal.ratio.toFixed(3) : "—"}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div style={{ opacity: loading ? 0.45 : 1, transition: "opacity 150ms" }}>
              <BarChart a={a.series} b={b?.series ?? []} bucket={bucket} goal={data?.goal ?? null} />
            </div>
            {data?.goal && nextGoal && (
              <div style={{ fontSize: 13, marginTop: 8, color: "var(--text-2)", display: "grid", gap: 4 }}>
                <div>
                  <b style={{ color: "var(--good)" }}>Goal for {fmtBucket(nextGoal.bucket, "month")}: {usd(nextGoal.goal)}</b>
                  <span style={{ color: "var(--text-3)" }}> = {fmtBucket(addYears(nextGoal.bucket, -1), "month")} {usd(nextGoal.lastYear)} × {data.goal.ratio?.toFixed(3)}. Growth is {periodLabel(from, to)} ({usd(data.goal.periodNet)}) ÷ {periodLabel(cfrom, cto)} ({usd(data.goal.compareNet)}).</span>
                  {laterGoals.length > 0 && <span style={{ color: "var(--text-3)" }}> Then {laterGoals.map((g) => `${fmtBucket(g.bucket, "month")} ${usd(g.goal)}`).join(", ")}.</span>}
                </div>
                <div>
                  <b style={{ color: NORMALIZED_COLOR }}>Normalized: {usd(nextGoal.normalized)}</b>
                  <span style={{ color: "var(--text-3)" }}> = avg of {fmtBucket(addYears(nextGoal.bucket, -1), "month")} {usd(nextGoal.lastYear)} and {fmtBucket(addYears(nextGoal.bucket, -2), "month")} {usd(nextGoal.twoYearsAgo)} = {usd(nextGoal.base2)}, × the same {data.goal.ratio?.toFixed(3)}. Halves one-off months like Dec 2025 while keeping the seasonal shape.</span>
                  {laterGoals.length > 0 && <span style={{ color: "var(--text-3)" }}> Then {laterGoals.map((g) => `${fmtBucket(g.bucket, "month")} ${usd(g.normalized)}`).join(", ")}.</span>}
                </div>
              </div>
            )}
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table className="data-table" style={{ fontSize: 13, width: "100%" }}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Period</th><th style={{ textAlign: "right" }}>Net</th><th style={{ textAlign: "right" }}>Orders</th><th style={{ textAlign: "right" }}>Discounts</th>
                    <th style={{ borderLeft: "1px solid var(--border)" }}>Compare</th><th style={{ textAlign: "right" }}>Net</th><th style={{ textAlign: "right" }}>Orders</th><th style={{ textAlign: "right" }}>Discounts</th>
                    <th style={{ textAlign: "right" }}>Δ net</th>
                    {data?.goal && <th style={{ textAlign: "right", borderLeft: "1px solid var(--border)" }}>Goal</th>}
                    {data?.goal && <th style={{ textAlign: "right" }}>vs goal</th>}
                    {data?.goal && <th style={{ textAlign: "right" }}>Normalized</th>}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: Math.max(a.series.length, b?.series.length ?? 0) }).map((_, i) => {
                    const ra = a.series[i];
                    const rb = b?.series[i];
                    const g = ra && data?.goal ? goalByMonth.get(ra.bucket.slice(0, 7)) : undefined;
                    return (
                      <tr key={i}>
                        <td style={{ color: "var(--text-3)" }}>{i + 1}</td>
                        <td>{ra ? fmtBucket(ra.bucket, bucket) : "—"}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 650 }}>{usd(ra?.net)}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{ra?.orders ?? "—"}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}>{usd(ra?.discounts)}</td>
                        <td style={{ borderLeft: "1px solid var(--border)", color: "var(--text-2)" }}>{rb ? fmtBucket(rb.bucket, bucket) : "—"}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usd(rb?.net)}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{rb?.orders ?? "—"}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}>{usd(rb?.discounts)}</td>
                        <td style={{ textAlign: "right" }}><DeltaTag x={ra?.net} y={rb?.net} /></td>
                        {data?.goal && <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--good)", borderLeft: "1px solid var(--border)" }}>{usd(g?.goal)}</td>}
                        {data?.goal && <td style={{ textAlign: "right" }}>{g?.goal != null && ra ? <DeltaTag x={ra.net} y={g.goal} /> : "—"}</td>}
                        {data?.goal && <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: NORMALIZED_COLOR }}>{usd(g?.normalized)}</td>}
                      </tr>
                    );
                  })}
                  {futureGoals.map((g) => (
                    <tr key={g.bucket} style={{ opacity: 0.75 }}>
                      <td style={{ color: "var(--text-3)" }}>→</td>
                      <td style={{ color: "var(--text-3)" }}>{fmtBucket(g.bucket, "month")} (upcoming)</td>
                      <td colSpan={8} style={{ color: "var(--text-3)", fontSize: 12 }}>
                        {fmtBucket(addYears(g.bucket, -1), "month")} {usd(g.lastYear)} × {data?.goal?.ratio?.toFixed(3) ?? "—"} · normalized: avg({usd(g.lastYear)}, {usd(g.twoYearsAgo)}) = {usd(g.base2)} × {data?.goal?.ratio?.toFixed(3) ?? "—"}
                      </td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--good)", fontWeight: 650, borderLeft: "1px solid var(--border)" }}>{usd(g.goal)}</td>
                      <td />
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: NORMALIZED_COLOR, fontWeight: 650 }}>{usd(g.normalized)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 8 }}>Rows are aligned by position (1st {bucket} vs 1st {bucket}). Same method as Shopify&apos;s sales reports: gross and discounts book on the order date, returns on the refund date, and cancelled orders show up as returns.</div>
          </div>

          {data?.customerValue && (
            <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontWeight: 750 }}>Average camper customer value by month</div>
                <div style={{ fontSize: 12, color: "var(--text-3)", display: "flex", gap: 14 }}>
                  {cvYears.map((yr, i) => (
                    <span key={yr}><span style={{ display: "inline-block", width: 14, height: 0, borderTop: `3px solid ${YEAR_COLORS[i] ?? "var(--text-3)"}`, marginRight: 5, verticalAlign: "middle" }} />{yr}</span>
                  ))}
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-3)", margin: "4px 0 8px" }}>
                A customer&apos;s orders within {data.customerValue.gapDays} days of each other count as one purchase. It counts when any order in it nets over {usd(thresholdUsd * 100)}, and it lands in the month of the last payment over that amount. Its value is every order in it (deposit included) up to 60 days after that last big payment, so install-time add-ons count but a later accessory neither moves nor inflates it. Customers deduped by name. The newest month can still rise as remaining balances come in.
              </div>
              <div style={{ opacity: loading ? 0.45 : 1, transition: "opacity 150ms" }}>
                <LineChart rows={data.customerValue.rows} years={cvYears} />
              </div>
              <div style={{ overflowX: "auto", marginTop: 10 }}>
                <table className="data-table" style={{ fontSize: 13, width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Month</th>
                      {cvYears.map((yr) => (
                        <th key={yr} colSpan={2} style={{ textAlign: "right", borderLeft: "1px solid var(--border)" }}>{yr} avg · purchases</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 12 }).map((_, mi) => (
                      <tr key={mi}>
                        <td>{new Date(2000, mi, 1).toLocaleDateString("en-US", { month: "short" })}</td>
                        {cvYears.map((yr) => {
                          const r = cvByKey.get(`${yr}-${String(mi + 1).padStart(2, "0")}`);
                          return (
                            <Fragment key={yr}>
                              <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 650, borderLeft: "1px solid var(--border)" }}>{usd(r?.avgCents)}</td>
                              <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}>{r?.purchases ?? "—"}</td>
                            </Fragment>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data?.purchaseSource && (
            <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontWeight: 750 }}>Camper purchases: sales team vs organic web</div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 12, color: "var(--text-3)" }}>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--accent)", borderRadius: 2, marginRight: 5 }} />Sales team</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#7aa7d9", borderRadius: 2, marginRight: 5 }} />Organic web</span>
                  <span style={{ display: "flex", gap: 4 }}>
                    <button className={`btn ${srcMode === "count" ? "primary" : "ghost"}`} style={{ padding: "3px 9px", fontSize: 12 }} onClick={() => setSrcMode("count")}>Purchases</button>
                    <button className={`btn ${srcMode === "value" ? "primary" : "ghost"}`} style={{ padding: "3px 9px", fontSize: 12 }} onClick={() => setSrcMode("value")}>Value</button>
                  </span>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-3)", margin: "4px 0 8px" }}>
                Same purchases as the customer-value chart. A purchase is <b>sales team</b> when the customer&apos;s first order in it was built by staff in Shopify (draft order, invoice or POS rather than their own web checkout), any order through the last camper payment used a rep&apos;s discount code (PARKER, JACKSON-…), or the customer had a logged rep conversation in the {data.purchaseSource.gapDays} days before that payment (CRM history starts mid-2026). Everything else is <b>organic web</b>. Balance invoices are always staff-built, so only the first order counts for that signal.
              </div>
              <div style={{ opacity: loading ? 0.45 : 1, transition: "opacity 150ms" }}>
                <SourceBars rows={data.purchaseSource.rows} mode={srcMode} />
              </div>
              <div style={{ overflowX: "auto", marginTop: 10 }}>
                <table className="data-table" style={{ fontSize: 13, width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th style={{ textAlign: "right" }}>Sales team</th><th style={{ textAlign: "right" }}>Value</th>
                      <th style={{ textAlign: "right", borderLeft: "1px solid var(--border)" }}>Organic web</th><th style={{ textAlign: "right" }}>Value</th>
                      <th style={{ textAlign: "right", borderLeft: "1px solid var(--border)" }}>Sales share</th>
                      <th style={{ textAlign: "right" }}>Signals: staff-built · rep code · CRM call</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.purchaseSource.rows].reverse().map((r) => {
                      const total = r.sales + r.organic;
                      return (
                        <tr key={r.month}>
                          <td>{fmtBucket(r.month, "month")}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 650 }}>{r.sales}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}>{usd(r.salesCents)}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 650, borderLeft: "1px solid var(--border)" }}>{r.organic}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}>{usd(r.organicCents)}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", borderLeft: "1px solid var(--border)" }}>{total ? `${Math.round((r.sales / total) * 100)}%` : "—"}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}>{r.sigDraft} · {r.sigRepcode} · {r.sigCrm}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data?.klaviyo && (
            <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontWeight: 750 }}>Revenue Klaviyo should actually get</div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 12, color: "var(--text-3)", flexWrap: "wrap" }}>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--surface-3)", border: "1px solid var(--border)", borderRadius: 2, marginRight: 5 }} />Organic revenue (no sales person)</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: KLAVIYO_COLOR, borderRadius: 2, marginRight: 5 }} />Clicked a Klaviyo email</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 10, background: KLAVIYO_SOFT, borderRadius: 2, marginRight: 5 }} />Only opened one</span>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    within
                    <select value={kwin} onChange={(e) => setKwin(Number(e.target.value) as 1 | 3 | 5 | 7 | 14)} style={{ ...inputStyle, padding: "2px 6px", fontSize: 12 }}>
                      {[1, 3, 5, 7, 14].map((d) => <option key={d} value={d}>{d} day{d === 1 ? "" : "s"}</option>)}
                    </select>
                    before the order
                  </label>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-3)", margin: "4px 0 8px" }}>
                Every order counts here, accessories and merch included. An order is organic when no sales person was involved, using the same rules as the sales-vs-organic chart (orders inside a camper purchase inherit that purchase&apos;s status). Of those, Klaviyo gets credit when the customer clicked (or only opened) a Klaviyo email in the window before ordering. Klaviyo&apos;s own default is 5 days and counts opens, which is where the over-attribution comes from.
                {data.klaviyo.coverageFrom && <> Email engagement history starts {fmtDate(data.klaviyo.coverageFrom)}, so earlier months show no attribution.</>}
              </div>
              <div style={{ opacity: loading ? 0.45 : 1, transition: "opacity 150ms" }}>
                <KlaviyoBars rows={data.klaviyo.rows.filter((r) => !data.klaviyo!.coverageFrom || r.month >= data.klaviyo!.coverageFrom.slice(0, 7) + "-01")} />
              </div>
              <div style={{ overflowX: "auto", marginTop: 10 }}>
                <table className="data-table" style={{ fontSize: 13, width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th style={{ textAlign: "right" }}>All revenue</th>
                      <th style={{ textAlign: "right", borderLeft: "1px solid var(--border)" }}>Organic</th><th style={{ textAlign: "right" }}>Orders</th>
                      <th style={{ textAlign: "right", borderLeft: "1px solid var(--border)" }}>Klaviyo click</th><th style={{ textAlign: "right" }}>Orders</th>
                      <th style={{ textAlign: "right", borderLeft: "1px solid var(--border)" }}>Open only</th><th style={{ textAlign: "right" }}>Orders</th>
                      <th style={{ textAlign: "right", borderLeft: "1px solid var(--border)" }}>Klaviyo share of all</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.klaviyo.rows].reverse().map((r) => (
                      <tr key={r.month}>
                        <td>{fmtBucket(r.month, "month")}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}>{usd(r.allCents)}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", borderLeft: "1px solid var(--border)" }}>{usd(r.organicCents)}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}>{r.organicOrders}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 650, color: KLAVIYO_COLOR, borderLeft: "1px solid var(--border)" }}>{usd(r.clickCents)}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}>{r.clickOrders}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", borderLeft: "1px solid var(--border)" }}>{usd(r.openCents)}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}>{r.openOrders}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", borderLeft: "1px solid var(--border)" }}>
                          {r.allCents > 0 ? `${((r.clickCents / r.allCents) * 100).toFixed(1)}% · ${(((r.clickCents + r.openCents) / r.allCents) * 100).toFixed(1)}% w/ opens` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 14, marginTop: 14 }}>
            <div className="card" style={{ padding: "14px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontWeight: 750 }}>Customers with orders over {usd(thresholdUsd * 100)}</div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className={`btn ${showBig === "a" ? "primary" : "ghost"}`} style={{ padding: "3px 9px", fontSize: 12 }} onClick={() => setShowBig("a")}>Period</button>
                  <button className={`btn ${showBig === "b" ? "primary" : "ghost"}`} style={{ padding: "3px 9px", fontSize: 12 }} onClick={() => setShowBig("b")}>Compare</button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 8 }}>
                One row per customer name — split payments on one camper collapse into a single row. Amounts are net for the selected collections.
              </div>
              <div style={{ maxHeight: 420, overflowY: "auto" }}>
                <table className="data-table" style={{ fontSize: 13, width: "100%" }}>
                  <thead><tr><th>Customer</th><th style={{ textAlign: "right" }}>Orders</th><th style={{ textAlign: "right" }}>Net</th><th>Dates</th></tr></thead>
                  <tbody>
                    {bigList.map((c) => (
                      <tr key={c.ckey}>
                        <td>
                          <div style={{ fontWeight: 650 }}>{c.customer_name ?? c.email ?? "Unknown"}</div>
                          <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{c.order_names.join(", ")}</div>
                        </td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{c.orders}{c.orders > 1 ? " ⚠" : ""}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 650 }}>{usd(c.net)}</td>
                        <td style={{ fontSize: 12, color: "var(--text-2)", whiteSpace: "nowrap" }}>
                          {fmtDate(c.first_at)}{c.last_at.slice(0, 10) !== c.first_at.slice(0, 10) ? ` → ${fmtDate(c.last_at)}` : ""}
                        </td>
                      </tr>
                    ))}
                    {bigList.length === 0 && <tr><td colSpan={4} style={{ color: "var(--text-3)" }}>None in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card" style={{ padding: "14px 18px" }}>
              <div style={{ fontWeight: 750, marginBottom: 8 }}>Where the discounts went</div>
              <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 8 }}>
                Discount codes and manual discounts, by amount given away in the period.
                {a.totals.depositCredits > 0 && (
                  <> Deposit / down-payment credits ({usd(a.totals.depositCredits)}{b ? `, prior ${usd(b.totals.depositCredits)}` : ""}) are money already taken on an earlier order and are not listed here.</>
                )}
              </div>
              <div style={{ maxHeight: 420, overflowY: "auto" }}>
                <table className="data-table" style={{ fontSize: 13, width: "100%" }}>
                  <thead><tr><th>Discount</th><th style={{ textAlign: "right" }}>Given</th><th style={{ textAlign: "right" }}>Orders</th><th style={{ textAlign: "right" }}>Compare</th></tr></thead>
                  <tbody>
                    {a.discounts.map((d) => {
                      const prior = b?.discounts.find((x) => x.label === d.label);
                      return (
                        <tr key={d.label}>
                          <td style={{ fontWeight: 650 }}>{d.label}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usd(d.cents)}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{d.orders}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}>{usd(prior?.cents ?? 0)}</td>
                        </tr>
                      );
                    })}
                    {a.discounts.length === 0 && <tr><td colSpan={4} style={{ color: "var(--text-3)" }}>No discounts in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      {data && (
        <div className="card" style={{ marginTop: 14, padding: "12px 18px", fontSize: 12.5, color: "var(--text-2)" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
            <span>
              <b>{data.sync.orders.toLocaleString()}</b> orders mirrored
              {data.sync.oldestOrderAt ? ` since ${fmtDate(data.sync.oldestOrderAt)}` : ""}
              {data.sync.done ? "" : " · full history backfill in progress"}
              {data.sync.lastIncrementalAt ? ` · last refresh ${new Date(data.sync.lastIncrementalAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12 }} disabled={!!syncing} onClick={() => runSync("incremental")}>{syncing === "incremental" ? "Syncing…" : "↻ Refresh orders"}</button>
              {!data.sync.done && <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12 }} disabled={!!syncing} onClick={() => runSync("full")}>{syncing === "full" ? "Backfilling…" : "Continue backfill"}</button>}
              <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12 }} disabled={!!syncing} onClick={() => runSync("catalog")}>{syncing === "catalog" ? "Syncing…" : "Sync collections"}</button>
            </span>
          </div>
          {data.sync.catalogError && (
            <div style={{ marginTop: 6, color: "var(--warn, #d9a441)" }}>
              Collection sync needs the <code>read_products</code> scope on the Shopify Admin app (Dev Dashboard → app → Configuration → Admin API scopes, then release). Until then the collection map is the one seeded on {data.sync.catalogAt ? fmtDate(data.sync.catalogAt) : "setup"} and new products land in “no collection”.
            </div>
          )}
          {syncMsg && <div style={{ marginTop: 6 }}>{syncMsg}</div>}
        </div>
      )}
    </div>
  );
}

function BarChart({ a, b, bucket, goal }: { a: Series[]; b: Series[]; bucket: Bucket; goal: Goal | null }) {
  // Month mode with a goal line: columns = every month of the period plus the
  // upcoming horizon; otherwise columns = the report buckets by position.
  const goalMonths = bucket === "month" && goal ? goal.months : [];
  const aByMonth = new Map(a.map((s) => [s.bucket.slice(0, 7), s]));
  const cols: { ra?: Series; rb?: Series; g?: GoalMonth; label: string; future: boolean }[] = goalMonths.length
    ? goalMonths.map((g, i) => ({ ra: aByMonth.get(g.bucket.slice(0, 7)), rb: b[i], g, label: fmtBucket(g.bucket, "month"), future: g.future }))
    : Array.from({ length: Math.max(a.length, b.length) }).map((_, i) => ({ ra: a[i], rb: b[i], label: fmtBucket((a[i] ?? b[i]).bucket, bucket), future: false }));
  const n = cols.length;
  if (n === 0) return <div style={{ color: "var(--text-3)", fontSize: 13, padding: "20px 0" }}>No orders in this period.</div>;
  const W = 900, H = 220, padL = 56, padB = 26, padT = 10;
  const max = Math.max(1, ...a.map((s) => s.net), ...b.map((s) => s.net), ...goalMonths.map((g) => Math.max(g.goal ?? 0, g.normalized ?? 0)));
  const innerW = W - padL - 8;
  const innerH = H - padB - padT;
  const group = innerW / n;
  const bw = Math.max(2, Math.min(28, (group - 6) / 2));
  const y = (v: number) => padT + innerH - (Math.max(0, v) / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = n > 40 ? Math.ceil(n / 20) : n > 16 ? 2 : 1;
  const cx = (i: number) => padL + i * group + group / 2;
  const goalPts = cols.map((c, i) => (c.g?.goal != null ? { x: cx(i), y: y(c.g.goal), future: c.future, g: c.g } : null));
  const normPts = cols.map((c, i) => (c.g?.normalized != null ? { x: cx(i), y: y(c.g.normalized), future: c.future, g: c.g } : null));
  const path = (pts: typeof goalPts) => pts.filter(Boolean).map((p, i) => `${i === 0 ? "M" : "L"}${p!.x.toFixed(1)},${p!.y.toFixed(1)}`).join(" ");
  const lastActualIdx = cols.reduce((m, c, i) => (!c.future ? i : m), -1);
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 520, height: "auto", display: "block" }} role="img" aria-label="Net revenue by period, this period vs comparison, with seasonal goal line">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - 8} y1={y(t)} y2={y(t)} stroke="var(--border-soft)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} fontSize={10} fill="var(--text-3)" textAnchor="end">{usd(t, { compact: true })}</text>
          </g>
        ))}
        {cols.some((c) => c.future) && lastActualIdx >= 0 && (
          <rect x={padL + (lastActualIdx + 1) * group} y={padT} width={(n - lastActualIdx - 1) * group} height={innerH} fill="var(--surface-2)" opacity={0.5} />
        )}
        {cols.map((c, i) => {
          const { ra, rb } = c;
          const x0 = padL + i * group + (group - (bw * 2 + 3)) / 2;
          return (
            <g key={i}>
              {ra && <rect x={x0} y={y(ra.net)} width={bw} height={Math.max(0, padT + innerH - y(ra.net))} fill="var(--accent)" rx={2}><title>{`${fmtBucket(ra.bucket, bucket)}: ${usd(ra.net)} net · ${ra.orders} orders`}</title></rect>}
              {rb && <rect x={x0 + bw + 3} y={y(rb.net)} width={bw} height={Math.max(0, padT + innerH - y(rb.net))} fill="var(--accent-2)" rx={2} opacity={0.85}><title>{`${fmtBucket(rb.bucket, bucket)}: ${usd(rb.net)} net · ${rb.orders} orders`}</title></rect>}
              {i % labelEvery === 0 && (
                <text x={cx(i)} y={H - 8} fontSize={10} fill="var(--text-3)" textAnchor="middle" fontStyle={c.future ? "italic" : "normal"}>{c.label}</text>
              )}
            </g>
          );
        })}
        {normPts.some(Boolean) && (
          <g>
            <path d={path(normPts)} fill="none" stroke={NORMALIZED_COLOR} strokeWidth={2} strokeDasharray="3 4" strokeLinejoin="round" opacity={0.9} />
            {normPts.map((p, i) => p && (
              <circle key={i} cx={p.x} cy={p.y} r={p.future ? 4 : 3} fill={p.future ? NORMALIZED_COLOR : "var(--surface-1)"} stroke={NORMALIZED_COLOR} strokeWidth={2}>
                <title>{`Normalized ${fmtBucket(p.g.bucket, "month")}: ${usd(p.g.normalized)} = avg(${usd(p.g.lastYear)}, ${usd(p.g.twoYearsAgo)}) = ${usd(p.g.base2)} × ${goal?.ratio?.toFixed(3)}`}</title>
              </circle>
            ))}
          </g>
        )}
        {goalPts.some(Boolean) && (
          <g>
            <path d={path(goalPts)} fill="none" stroke="var(--good)" strokeWidth={2} strokeDasharray="6 4" strokeLinejoin="round" />
            {goalPts.map((p, i) => p && (
              <circle key={i} cx={p.x} cy={p.y} r={p.future ? 4 : 3} fill={p.future ? "var(--good)" : "var(--surface-1)"} stroke="var(--good)" strokeWidth={2}>
                <title>{`Goal ${fmtBucket(p.g.bucket, "month")}: ${usd(p.g.goal)} = ${usd(p.g.lastYear)} last year × ${goal?.ratio?.toFixed(3)}`}</title>
              </circle>
            ))}
          </g>
        )}
      </svg>
    </div>
  );
}

/** Car-style half gauge: red / amber / green bands, a target diamond, a needle. */
function Gauge({ value, bands, title, sub, muted }: { value: number | null; bands: Health["bands"]; title: string; sub: string; muted?: boolean }) {
  const max = Math.max(bands.target * 1.25, (value ?? 0) * 1.05, 120_000_000);
  const W = 320, H = 218, cx = 160, cy = 160, R = 130, r = 98;
  const ang = (v: number) => Math.PI - (Math.min(Math.max(v, 0), max) / max) * Math.PI; // π → 0, left to right
  const pt = (rad: number, a: number) => [cx + rad * Math.cos(a), cy - rad * Math.sin(a)] as const;
  const arc = (from: number, to: number, color: string) => {
    const a0 = ang(from), a1 = ang(to);
    const [x0, y0] = pt(R, a0), [x1, y1] = pt(R, a1), [x2, y2] = pt(r, a1), [x3, y3] = pt(r, a0);
    const large = a0 - a1 > Math.PI ? 1 : 0;
    return <path d={`M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z`} fill={color} opacity={muted ? 0.35 : 0.85} />;
  };
  const band = value == null ? null : value < bands.unhealthyBelow ? "unhealthy" : value < bands.okBelow ? "ok" : value >= bands.target ? "on target" : "optimal";
  const bandColor = band === "unhealthy" ? "var(--crit)" : band === "ok" ? NORMALIZED_COLOR : "var(--good)";
  const needle = value != null ? ang(value) : null;
  const [tx, ty] = pt(R + 10, ang(bands.target));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  return (
    <div style={{ display: "grid", justifyItems: "center", gap: 2, opacity: muted ? 0.7 : 1 }}>
      <div style={{ fontSize: 12, color: "var(--text-3)", fontWeight: 750, letterSpacing: "0.06em", textTransform: "uppercase" }}>{title}</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 340, height: "auto", display: "block" }} role="img" aria-label={`${title}: ${usd(value)}`}>
        {arc(0, bands.unhealthyBelow, "var(--crit)")}
        {arc(bands.unhealthyBelow, bands.okBelow, NORMALIZED_COLOR)}
        {arc(bands.okBelow, max, "var(--good)")}
        {ticks.map((t, i) => {
          const [x1, y1] = pt(r - 4, ang(t)), [x2, y2] = pt(r - 12, ang(t)), [lx, ly] = pt(r - 24, ang(t));
          return (
            <g key={i}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--text-3)" strokeWidth={1.5} />
              <text x={lx} y={ly + 3} fontSize={9} fill="var(--text-3)" textAnchor="middle">{usd(t, { compact: true })}</text>
            </g>
          );
        })}
        <g transform={`translate(${tx},${ty}) rotate(45)`}>
          <rect x={-5} y={-5} width={10} height={10} fill="var(--text-1)" stroke="var(--surface-1)" strokeWidth={1.5}>
            <title>{`Target ${usd(bands.target)}`}</title>
          </rect>
        </g>
        {needle != null && (
          <g>
            <line x1={cx} y1={cy} x2={pt(R - 6, needle)[0]} y2={pt(R - 6, needle)[1]} stroke="var(--text-1)" strokeWidth={3.5} strokeLinecap="round" />
            <circle cx={cx} cy={cy} r={7} fill="var(--text-1)" />
          </g>
        )}
        <text x={cx} y={cy + 30} fontSize={22} fontWeight={800} fill="var(--text-1)" textAnchor="middle" style={{ fontVariantNumeric: "tabular-nums" }}>{usd(value)}</text>
        {band && <text x={cx} y={cy + 48} fontSize={11} fontWeight={750} fill={bandColor} textAnchor="middle" letterSpacing="0.08em">{band.toUpperCase()}</text>}
      </svg>
      {value != null && (
        <div style={{ fontSize: 13, color: "var(--text-2)", fontWeight: 650 }}>
          ≈ {(value / AVG_SALE_CENTS).toFixed(1)} campers / month <span style={{ color: "var(--text-3)", fontWeight: 500 }}>at a {usd(AVG_SALE_CENTS)} average sale</span>
        </div>
      )}
      <div style={{ fontSize: 12, color: "var(--text-3)", textAlign: "center", maxWidth: 340 }}>{sub}</div>
    </div>
  );
}

/** Jan–Dec line chart, one line per year (current year brightest). */
function LineChart({ rows, years }: { rows: CvRow[]; years: string[] }) {
  if (rows.length === 0) return <div style={{ color: "var(--text-3)", fontSize: 13, padding: "20px 0" }}>No qualifying purchases yet.</div>;
  const W = 900, H = 240, padL = 56, padR = 12, padT = 12, padB = 26;
  const byKey = new Map(rows.map((r) => [r.month.slice(0, 7), r]));
  const vals = rows.map((r) => r.avgCents);
  const max = Math.max(1, ...vals) * 1.08;
  const min = Math.max(0, Math.min(...vals) * 0.85);
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const x = (mi: number) => padL + (mi / 11) * innerW;
  const y = (v: number) => padT + innerH - ((v - min) / (max - min)) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + f * (max - min));
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 520, height: "auto", display: "block" }} role="img" aria-label="Average camper customer value by month, one line per year">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border-soft)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} fontSize={10} fill="var(--text-3)" textAnchor="end">{usd(t, { compact: true })}</text>
          </g>
        ))}
        {Array.from({ length: 12 }).map((_, mi) => (
          <text key={mi} x={x(mi)} y={H - 8} fontSize={10} fill="var(--text-3)" textAnchor="middle">
            {new Date(2000, mi, 1).toLocaleDateString("en-US", { month: "short" })}
          </text>
        ))}
        {years.map((yr, yi) => {
          const color = YEAR_COLORS[yi] ?? "var(--text-3)";
          const pts = Array.from({ length: 12 }).map((_, mi) => {
            const r = byKey.get(`${yr}-${String(mi + 1).padStart(2, "0")}`);
            return r ? { mi, r } : null;
          });
          const d = pts.filter(Boolean).map((p, i) => `${i === 0 ? "M" : "L"}${x(p!.mi).toFixed(1)},${y(p!.r.avgCents).toFixed(1)}`).join(" ");
          return (
            <g key={yr}>
              <path d={d} fill="none" stroke={color} strokeWidth={yi === 0 ? 2.5 : 2} opacity={yi === 0 ? 1 : 0.8} strokeLinejoin="round" strokeLinecap="round" />
              {pts.map((p) => p && (
                <circle key={p.mi} cx={x(p.mi)} cy={y(p.r.avgCents)} r={yi === 0 ? 4 : 3} fill={color} stroke="var(--surface-1)" strokeWidth={1.5}>
                  <title>{`${new Date(2000, p.mi, 1).toLocaleDateString("en-US", { month: "short" })} ${yr}: avg ${usd(p.r.avgCents)} · median ${usd(p.r.medianCents)} · ${p.r.purchases} purchases`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Grouped bars per month: sales-team vs organic-web camper purchases (count or value). */
function SourceBars({ rows, mode }: { rows: SrcRow[]; mode: "count" | "value" }) {
  if (rows.length === 0) return <div style={{ color: "var(--text-3)", fontSize: 13, padding: "20px 0" }}>No qualifying purchases yet.</div>;
  const W = 900, H = 240, padL = 48, padR = 8, padT = 12, padB = 26;
  const n = rows.length;
  const val = (r: SrcRow, k: "sales" | "organic") => (mode === "count" ? r[k] : k === "sales" ? r.salesCents : r.organicCents);
  const max = Math.max(1, ...rows.flatMap((r) => [val(r, "sales"), val(r, "organic")]));
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const group = innerW / n;
  const bw = Math.max(2, Math.min(22, (group - 6) / 2));
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const fmt = (v: number) => (mode === "count" ? String(v) : usd(v, { compact: true }));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * max));
  const labelEvery = n > 18 ? 2 : 1;
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 520, height: "auto", display: "block" }} role="img" aria-label="Camper purchases per month, sales team vs organic web">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border-soft)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} fontSize={10} fill="var(--text-3)" textAnchor="end">{fmt(t)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x0 = padL + i * group + (group - (bw * 2 + 3)) / 2;
          const s = val(r, "sales"), o = val(r, "organic");
          const label = fmtBucket(r.month, "month");
          return (
            <g key={r.month}>
              <rect x={x0} y={y(s)} width={bw} height={Math.max(0, padT + innerH - y(s))} fill="var(--accent)" rx={2}>
                <title>{`${label} sales team: ${r.sales} purchases · ${usd(r.salesCents)} (staff-built ${r.sigDraft}, rep code ${r.sigRepcode}, CRM call ${r.sigCrm})`}</title>
              </rect>
              <rect x={x0 + bw + 3} y={y(o)} width={bw} height={Math.max(0, padT + innerH - y(o))} fill="#7aa7d9" rx={2}>
                <title>{`${label} organic web: ${r.organic} purchases · ${usd(r.organicCents)}`}</title>
              </rect>
              {i % labelEvery === 0 && <text x={x0 + bw + 1.5} y={H - 8} fontSize={10} fill="var(--text-3)" textAnchor="middle">{label}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Per month: organic revenue (outline) with the Klaviyo-attributed part stacked inside (click, then open-only). */
function KlaviyoBars({ rows }: { rows: KlavRow[] }) {
  if (rows.length === 0) return <div style={{ color: "var(--text-3)", fontSize: 13, padding: "20px 0" }}>No months with email engagement history yet.</div>;
  const W = 900, H = 240, padL = 56, padR = 8, padT = 12, padB = 26;
  const n = rows.length;
  const max = Math.max(1, ...rows.map((r) => r.organicCents));
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const group = innerW / n;
  const bw = Math.max(6, Math.min(44, group - 10));
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 520, height: "auto", display: "block" }} role="img" aria-label="Organic revenue per month with the Klaviyo-attributed portion">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border-soft)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} fontSize={10} fill="var(--text-3)" textAnchor="end">{usd(t, { compact: true })}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x0 = padL + i * group + (group - bw) / 2;
          const label = fmtBucket(r.month, "month");
          const clickTop = y(r.clickCents);
          const openTop = y(r.clickCents + r.openCents);
          return (
            <g key={r.month}>
              <rect x={x0} y={y(r.organicCents)} width={bw} height={Math.max(0, padT + innerH - y(r.organicCents))} fill="var(--surface-3)" stroke="var(--border)" strokeWidth={1} rx={2}>
                <title>{`${label} organic revenue: ${usd(r.organicCents)} · ${r.organicOrders} orders (all revenue ${usd(r.allCents)})`}</title>
              </rect>
              <rect x={x0} y={openTop} width={bw} height={Math.max(0, clickTop - openTop)} fill={KLAVIYO_SOFT} rx={1}>
                <title>{`${label} only opened a Klaviyo email: ${usd(r.openCents)} · ${r.openOrders} orders`}</title>
              </rect>
              <rect x={x0} y={clickTop} width={bw} height={Math.max(0, padT + innerH - clickTop)} fill={KLAVIYO_COLOR} rx={1}>
                <title>{`${label} clicked a Klaviyo email: ${usd(r.clickCents)} · ${r.clickOrders} orders`}</title>
              </rect>
              <text x={x0 + bw / 2} y={H - 8} fontSize={10} fill="var(--text-3)" textAnchor="middle">{label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
