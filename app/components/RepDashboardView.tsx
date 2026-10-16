"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

/**
 * One rep's dashboard — the Reps table's numbers turned into pictures a rep
 * can read without a legend lesson. Built to be shown to the rep themselves
 * (/my-dashboard) once Kyle opens it up, so every chart carries a one-line
 * "what this means".
 *
 * Charts are plain SVG/CSS: stat tiles for headlines, a single-hue ordered
 * bar for staleness (magnitude of neglect), one line for conversion by cohort,
 * stacked weekly bars for activity mix (4 fixed categorical hues, direct
 * labels), and progress bars for coverage.
 */

interface Cohort { month: string; worked: number; confirmed: number; presumed: number; maturing: boolean }
interface Rep {
  email: string; name: string;
  book: { open: number; onPlan: number; planned: number; touchedInWindow: number; attempted: number; contacted: number; staleness: Record<string, number> };
  throughput: { workDays: number; touches: number; distinctDeals: number; touchesPerDay: number; dealsPerDay: number; impliedCapacity: number };
  conversion: { workedAll: number; confirmedAll: number; presumedAll: number; workedMatured: number; confirmedMatured: number; presumedMatured: number; cohorts: Cohort[] };
  reprospect: { claimed: number; attemptedInHold: number; takenOver: number };
}
interface Week { week: string; touches: number; deals: number; dials: number; conversations: number; emails: number; texts: number }

const pct = (n: number, d: number, digits = 0) => (d > 0 ? `${((100 * n) / d).toFixed(digits)}%` : "—");
const BUCKETS: { key: string; label: string; color: string }[] = [
  { key: "0-7", label: "this week", color: "#f3d9a4" },
  { key: "8-14", label: "1–2 weeks", color: "#e8b86d" },
  { key: "15-30", label: "2–4 weeks", color: "#d98f3c" },
  { key: "31-60", label: "1–2 months", color: "#bf5b2a" },
  { key: "60+", label: "2+ months", color: "#8e2d1e" },
  { key: "never", label: "never touched", color: "#8a8f98" },
];
const MIX = [
  { key: "dials", label: "Dials", color: "#4f7cff" },
  { key: "conversations", label: "Conversations", color: "#3a9d5d" },
  { key: "emails", label: "Emails", color: "#d9a62b" },
  { key: "texts", label: "Texts", color: "#c0392b" },
] as const;

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "good" ? "var(--good)" : tone === "warn" ? "var(--warn)" : tone === "bad" ? "var(--crit, #c0392b)" : undefined;
  return (
    <div className="card" style={{ padding: "12px 14px", minWidth: 160, flex: "1 1 160px" }}>
      <div style={{ fontSize: 12, color: "var(--text-3)" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 760, color, lineHeight: 1.15 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 8, lineHeight: 1.45 }}>{children}</div>;
}

export function RepDashboardView({ rep, backHref }: { rep: string; backHref?: string }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<{ reps: Rep[]; weekly?: Week[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    setData(null); setErr(null);
    fetch(`/api/admin/analytics/reps?rep=${encodeURIComponent(rep)}&days=${days}`).then((r) => r.json()).then((d) => (d.error ? setErr(d.error) : setData(d))).catch(() => setErr("failed to load"));
  }, [rep, days]);

  const r = data?.reps?.[0];
  const weeks = useMemo(() => (data?.weekly ?? []).slice(-12), [data]);

  if (err) return <div style={{ color: "var(--bad)" }}>{err}</div>;
  if (!data) return <div className="viewsub">Building dashboard…</div>;
  if (!r) return <div className="viewsub">No data for {rep}.</div>;

  const b = r.book, t = r.throughput, c = r.conversion, p = r.reprospect;
  const unplanned = BUCKETS.reduce((n, k) => n + (b.staleness[k.key] ?? 0), 0);
  const cold = (b.staleness["60+"] ?? 0) + (b.staleness.never ?? 0);
  const over = t.impliedCapacity > 0 ? b.open - t.impliedCapacity : 0;
  const matured = c.cohorts.filter((k) => !k.maturing && k.worked > 0);
  const convRate = c.workedMatured ? c.confirmedMatured / c.workedMatured : null;

  // Cohort line geometry.
  const W = 640, H = 180, PL = 36, PR = 12, PT = 12, PB = 28;
  const pts = c.cohorts.map((k, i) => ({ ...k, x: PL + (i * (W - PL - PR)) / Math.max(c.cohorts.length - 1, 1), rate: k.worked ? k.confirmed / k.worked : null, prate: k.worked ? k.presumed / k.worked : null }));
  const maxRate = Math.max(0.1, ...pts.map((q) => q.prate ?? 0)) * 1.15;
  const yOf = (v: number) => PT + (H - PT - PB) * (1 - v / maxRate);
  const path = (sel: (q: typeof pts[number]) => number | null) => pts.filter((q) => sel(q) != null).map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)},${yOf(sel(q)!).toFixed(1)}`).join(" ");
  const firstMaturing = pts.findIndex((q) => q.maturing);

  // Weekly bars geometry.
  const maxWeek = Math.max(1, ...weeks.map((w) => w.touches));

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {backHref && <Link href={backHref} className="btn ghost" style={{ padding: "4px 10px", fontSize: 12.5 }}>← All reps</Link>}
        <h2 style={{ margin: 0 }}>👤 {r.name}</h2>
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>Window</span>
          {[7, 14, 30, 90].map((d) => <button key={d} className={`btn ${days === d ? "primary" : "ghost"}`} style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => setDays(d)}>{d}d</button>)}
        </span>
      </div>

      {/* Headline tiles */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "14px 0 18px" }}>
        <Tile label="Open deals" value={b.open.toLocaleString()} sub={`${b.planned.toLocaleString()} with a future plan`} />
        <Tile label="Kept alive" value={pct(b.onPlan, b.open)} sub={`touched in ${days}d or planned ahead`} tone={b.open && b.onPlan / b.open >= 0.7 ? "good" : b.open && b.onPlan / b.open >= 0.4 ? "warn" : "bad"} />
        <Tile label="Going cold" value={cold.toLocaleString()} sub="no plan, 2+ months since your last touch" tone={cold === 0 ? "good" : cold > b.open * 0.3 ? "bad" : "warn"} />
        <Tile label="Deals touched per day" value={String(t.dealsPerDay)} sub={`${t.touches.toLocaleString()} touches · ${t.workDays} working days`} />
        <Tile label="Book this pace covers" value={t.impliedCapacity.toLocaleString()} sub={over > 0 ? `${over.toLocaleString()} more than that are open` : "covers the whole book monthly"} tone={over > 0 ? "warn" : "good"} />
        <Tile label="Conversion" value={convRate == null ? "—" : pct(c.confirmedMatured, c.workedMatured, 1)} sub={convRate == null ? "needs 60 days of history" : `${c.confirmedMatured} won of ${c.workedMatured.toLocaleString()} worked · ${pct(c.presumedMatured, c.workedMatured, 1)} incl. deposits`} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 16 }}>
        {/* Staleness */}
        <div className="card">
          <div className="panel-h" style={{ marginTop: 0 }}>Your open deals with no plan — when you last touched them</div>
          <div style={{ display: "flex", height: 28, borderRadius: 6, overflow: "hidden", gap: 2, background: "var(--surface-3)" }}>
            {BUCKETS.map((k) => {
              const n = b.staleness[k.key] ?? 0;
              if (!n) return null;
              const w = (100 * n) / Math.max(unplanned, 1);
              return (
                <div key={k.key} style={{ width: `${w}%`, background: k.color, display: "flex", alignItems: "center", justifyContent: "center", color: k.key === "0-7" || k.key === "8-14" ? "#2a1d0a" : "#fff", fontSize: 12, fontWeight: 700, minWidth: w > 6 ? undefined : 0, overflow: "hidden" }}
                  onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, text: `${k.label}: ${n.toLocaleString()} deals (${pct(n, unplanned)})` })} onMouseLeave={() => setHover(null)}>
                  {w > 6 ? n.toLocaleString() : ""}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
            {BUCKETS.map((k) => (
              <span key={k.key} style={{ fontSize: 12, color: "var(--text-2)", display: "inline-flex", gap: 6, alignItems: "center" }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: k.color, display: "inline-block" }} />{k.label} <b>{(b.staleness[k.key] ?? 0).toLocaleString()}</b>
              </span>
            ))}
          </div>
          <Caption>
            {unplanned.toLocaleString()} of your {b.open.toLocaleString()} open deals have nothing scheduled. The darker the bar, the longer since you touched them. A deal with a future activity booked isn't here even if it's been quiet; that's the plan working.
            {cold > 0 && <> <b>{cold.toLocaleString()} are going cold</b>: a call, text or a scheduled follow-up moves them back to the left.</>}
          </Caption>
        </div>

        {/* Coverage */}
        <div className="card">
          <div className="panel-h" style={{ marginTop: 0 }}>How much of your book you've worked</div>
          {[
            { label: `Kept alive (touched in ${days}d or planned)`, n: b.onPlan, color: "#3a9d5d" },
            { label: "Ever attempted (a dial, by anyone)", n: b.attempted, color: "#4f7cff" },
            { label: "Ever had a conversation", n: b.contacted, color: "#4f7cff" },
          ].map((row) => (
            <div key={row.label} style={{ margin: "10px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--text-2)" }}><span>{row.label}</span><b>{pct(row.n, b.open)} · {row.n.toLocaleString()}</b></div>
              <div style={{ height: 10, borderRadius: 4, background: "var(--surface-3)", overflow: "hidden", marginTop: 4 }}><div style={{ width: `${b.open ? (100 * row.n) / b.open : 0}%`, height: "100%", background: row.color, borderRadius: 4 }} /></div>
            </div>
          ))}
          <Caption>
            The first bar is the one to move. At <b>{t.dealsPerDay}</b> distinct deals a day you reach about <b>{t.impliedCapacity.toLocaleString()}</b> deals a month; your book is <b>{b.open.toLocaleString()}</b>.
            {over > 0 ? <> The gap is {over.toLocaleString()} deals, which is why some go cold. Snoozing, closing out dead ones, or a drip campaign for the email-only leads all shrink it.</> : <> You can cover the whole book monthly at this pace.</>}
          </Caption>
        </div>

        {/* Weekly activity */}
        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <div className="panel-h" style={{ marginTop: 0 }}>Activity by week (last 12 weeks)</div>
          <div style={{ display: "flex", gap: 6, alignItems: "flex-end", height: 160, padding: "0 4px" }}>
            {weeks.map((w) => (
              <div key={w.week} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%", gap: 2 }}
                onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, text: `Week of ${w.week}: ${w.touches} touches on ${w.deals} deals — ${w.dials} dials, ${w.conversations} conversations, ${w.emails} emails, ${w.texts} texts` })} onMouseLeave={() => setHover(null)}>
                <div style={{ fontSize: 11, color: "var(--text-2)", textAlign: "center", fontWeight: 600 }}>{w.deals}</div>
                {[...MIX].reverse().map((m) => {
                  const v = w[m.key as keyof Week] as number;
                  const h = (140 * v) / maxWeek;
                  return v > 0 ? <div key={m.key} style={{ height: Math.max(h, 2), background: m.color, borderRadius: 3 }} /> : null;
                })}
              </div>
            ))}
            {weeks.length === 0 && <div className="viewsub">No activity recorded yet.</div>}
          </div>
          <div style={{ display: "flex", gap: 6, padding: "4px 4px 0" }}>
            {weeks.map((w) => <div key={w.week} style={{ flex: 1, fontSize: 10.5, color: "var(--text-3)", textAlign: "center" }}>{w.week.slice(5).replace("-", "/")}</div>)}
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
            {MIX.map((m) => <span key={m.key} style={{ fontSize: 12, color: "var(--text-2)", display: "inline-flex", gap: 6, alignItems: "center" }}><span style={{ width: 10, height: 10, borderRadius: 2, background: m.color, display: "inline-block" }} />{m.label}</span>)}
          </div>
          <Caption>Bar height is total touches; the number on top is how many <b>different deals</b> you reached that week, which is the one that grows your coverage. A tall bar with a small number means lots of touches on the same few deals.</Caption>
        </div>

        {/* Conversion by cohort */}
        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <div className="panel-h" style={{ marginTop: 0 }}>Conversion by the month you first worked the lead</div>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block", overflow: "visible" }}>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f}><line x1={PL} x2={W - PR} y1={yOf(maxRate * f)} y2={yOf(maxRate * f)} stroke="var(--border-soft)" strokeWidth={1} /><text x={PL - 6} y={yOf(maxRate * f) + 4} fontSize={10} fill="var(--text-3)" textAnchor="end">{Math.round(maxRate * f * 100)}%</text></g>)}
            {firstMaturing >= 0 && <rect x={pts[firstMaturing].x - 8} y={PT} width={W - PR - pts[firstMaturing].x + 8} height={H - PT - PB} fill="var(--surface-3)" opacity={0.6} />}
            <path d={path((q) => q.prate)} fill="none" stroke="#d9a62b" strokeWidth={2} strokeDasharray="4 3" />
            <path d={path((q) => q.rate)} fill="none" stroke="#4f7cff" strokeWidth={2.5} />
            {pts.map((q) => q.rate != null && (
              <g key={q.month} onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, text: `${q.month}: ${q.confirmed} won of ${q.worked} worked (${pct(q.confirmed, q.worked, 1)}) · ${q.presumed} incl. deposits (${pct(q.presumed, q.worked, 1)})${q.maturing ? " · still maturing" : ""}` })} onMouseLeave={() => setHover(null)}>
                <circle cx={q.x} cy={yOf(q.rate)} r={9} fill="transparent" />
                <circle cx={q.x} cy={yOf(q.rate)} r={4} fill="#4f7cff" stroke="var(--surface-1, #fff)" strokeWidth={2} />
              </g>
            ))}
            {pts.map((q, i) => (i % 2 === 0 || pts.length <= 6) && <text key={`l${q.month}`} x={q.x} y={H - 8} fontSize={10} fill="var(--text-3)" textAnchor="middle">{q.month.slice(2).replace("-", "/")}</text>)}
          </svg>
          <div style={{ display: "flex", gap: 14, marginTop: 6, flexWrap: "wrap", fontSize: 12, color: "var(--text-2)" }}>
            <span><span style={{ display: "inline-block", width: 18, height: 3, background: "#4f7cff", verticalAlign: "middle", marginRight: 6 }} />Won</span>
            <span><span style={{ display: "inline-block", width: 18, height: 0, borderTop: "2px dashed #d9a62b", verticalAlign: "middle", marginRight: 6 }} />Won + deposit placed</span>
            <span><span style={{ display: "inline-block", width: 14, height: 10, background: "var(--surface-3)", verticalAlign: "middle", marginRight: 6 }} />Too recent to judge (under 60 days)</span>
          </div>
          <Caption>
            Each point is a batch of leads grouped by the month you first touched them, and the share of that batch that has closed. Recent months look low because those deals haven't had time yet; read the shaded months as "in progress", not failures.
            {matured.length > 0 ? <> Across matured months you've won <b>{pct(c.confirmedMatured, c.workedMatured, 1)}</b> of what you worked ({c.confirmedMatured} of {c.workedMatured.toLocaleString()}).</> : <> Your first batch becomes readable 60 days after you started working it.</>}
          </Caption>
        </div>

        {/* Reprospect */}
        <div className="card">
          <div className="panel-h" style={{ marginTop: 0 }}>Reprospecting pool (last {days} days)</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Tile label="Claimed" value={String(p.claimed)} sub="pool deals put on your lists" />
            <Tile label="Dialed during the hold" value={p.claimed ? `${p.attemptedInHold} · ${pct(p.attemptedInHold, p.claimed)}` : "—"} tone={p.claimed ? (p.attemptedInHold / p.claimed >= 0.7 ? "good" : "warn") : undefined} />
            <Tile label="Became yours" value={String(p.takenOver)} sub="you scheduled something" />
          </div>
          <Caption>A claimed pool deal is hidden from the other reps for 3 days. Claiming without dialing wastes that lock for the team; the middle number is the one to keep high.</Caption>
        </div>

        {/* Definitions */}
        <div className="card">
          <div className="panel-h" style={{ marginTop: 0 }}>How these are counted</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}>
            <li><b>Touch</b>: a dial, an answered call, an email you sent, or a text. Automated emails and system notes don't count.</li>
            <li><b>Kept alive</b>: touched in the window, or has a future scheduled activity. "Call me in six months" with a task booked counts.</li>
            <li><b>Worked</b>: any deal you've touched at least once. <b>Won</b> is credited to whoever owns the deal when it closes.</li>
            <li><b>Book this pace covers</b>: distinct deals you touch per working day × 21, i.e. the book size you'd reach once a month.</li>
          </ul>
        </div>
      </div>

      {hover && (
        <div style={{ position: "fixed", left: hover.x + 12, top: hover.y + 12, zIndex: 9000, background: "var(--surface-1, #fff)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", fontSize: 12.5, boxShadow: "0 6px 20px rgba(0,0,0,0.18)", maxWidth: 320, pointerEvents: "none" }}>
          {hover.text}
        </div>
      )}
    </>
  );
}
