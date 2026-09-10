"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

/**
 * ⚖ Reviews dashboard — the leading-KPI view over AI call reviews.
 * Every call ≥5min is auto-reviewed (ai-refresh cron mode=reviews); this
 * page turns the stored scorecards into daily/weekly/monthly stats:
 * average score per StoryBrand principle, trend vs the prior period, and
 * "quality calls" (score >= 3.5/5, partial = half credit). Reps see themselves; admins
 * also get a group comparison and can drill into any rep.
 */

type Verdict = "hit" | "partial" | "missed";
interface Review {
  id: string;
  rep: string | null;
  at: string;
  dealId: string | null;
  dealTitle: string | null;
  snapshot: string | null;
  scorecard: { principle: string; verdict: Verdict }[];
  thin: boolean;
}

const PRINCIPLES = ["Guide positioning", "Problem articulation", "Simple plan", "Clear CTA", "Discovery"];
const SHORT: Record<string, string> = {
  "Guide positioning": "Guide",
  "Problem articulation": "Problem",
  "Simple plan": "Plan",
  "Clear CTA": "CTA",
  Discovery: "Discovery",
};
const VERDICT_SCORE: Record<Verdict, number> = { hit: 1, partial: 0.5, missed: 0 };
// The standard (Kyle 9/9): avg score < 3/5 is below standard, AND a rep must
// keep volume within 60% of the period leader's reviewed-call count — the
// curve stops "I got my score, I'll stop dialing" sandbagging.
const STANDARD_AVG = 3.0;
const VOLUME_CURVE = 0.6;
const VERDICT_DOT: Record<Verdict, string> = { hit: "var(--good, #3aa76d)", partial: "#d99a2b", missed: "var(--crit, #c9502e)" };

type Period = "day" | "week" | "month";
const PERIOD_LABEL: Record<Period, string> = { day: "Today", week: "This week", month: "This month" };

function periodStart(p: Period, offset = 0): Date {
  const d = new Date();
  if (p === "day") {
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offset);
  } else if (p === "week") {
    d.setHours(0, 0, 0, 0);
    const day = (d.getDay() + 6) % 7; // Monday start
    d.setDate(d.getDate() - day - offset * 7);
  } else {
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    d.setMonth(d.getMonth() - offset);
  }
  return d;
}

function score(r: Review): number {
  return r.scorecard.reduce((s, x) => s + (VERDICT_SCORE[x.verdict] ?? 0), 0);
}
// Quality call = score ≥ 3.5/5 with partial = half credit (Kyle 9/9: strong
// across most categories, reachable — the strict 4-clean-hits bar read 0%).
function isQuality(r: Review): boolean {
  return r.scorecard.length === 5 && score(r) >= 3.5;
}

interface Agg {
  count: number;
  avg: number | null; // 0-5
  quality: number; // quality calls (score >= 3.5/5)
  qualityPct: number | null;
  perPrinciple: Record<string, number | null>; // avg 0-1
}

function aggregate(rows: Review[]): Agg {
  const scored = rows.filter((r) => r.scorecard.length === 5);
  const per: Record<string, number | null> = {};
  for (const p of PRINCIPLES) {
    const vals = scored
      .map((r) => r.scorecard.find((s) => s.principle === p))
      .filter(Boolean)
      .map((s) => VERDICT_SCORE[s!.verdict] ?? 0);
    per[p] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  const quality = scored.filter(isQuality).length;
  return {
    count: rows.length,
    avg: scored.length ? scored.reduce((a, r) => a + score(r), 0) / scored.length : null,
    quality,
    qualityPct: scored.length ? (quality / scored.length) * 100 : null,
    perPrinciple: per,
  };
}

function TrendArrow({ cur, prev }: { cur: number | null; prev: number | null }) {
  if (cur == null || prev == null) return null;
  const delta = cur - prev;
  if (Math.abs(delta) < 0.05) return <span style={{ color: "var(--text-3)", fontSize: 12 }}>→</span>;
  return (
    <span style={{ color: delta > 0 ? "var(--good, #3aa76d)" : "var(--crit, #c9502e)", fontSize: 12, fontWeight: 700 }}>
      {delta > 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(2)}
    </span>
  );
}

function Bar({ v }: { v: number | null }) {
  return (
    <div style={{ flex: 1, height: 8, borderRadius: 4, background: "var(--surface-3, #2a2d33)", overflow: "hidden" }}>
      {v != null && (
        <div
          style={{
            width: `${Math.round(v * 100)}%`,
            height: "100%",
            borderRadius: 4,
            background: v >= 0.7 ? "var(--good, #3aa76d)" : v >= 0.45 ? "#d99a2b" : "var(--crit, #c9502e)",
          }}
        />
      )}
    </div>
  );
}

// ── Growth over time ───────────────────────────────────────────────────────
// Weekly buckets over the 90-day window. Fixed per-rep colors (assignment by
// sorted name — never re-colored by rank or filtering).
const SERIES_COLORS = ["#4f7cff", "#e8623a", "#3aa76d", "#d99a2b", "#9a7be0", "#3aa0e8"];

type WeekPoint = { week: string; avg: number | null; qualityPct: number | null; count: number };

function weeklySeries(rows: Review[], weeks: Date[]): WeekPoint[] {
  return weeks.map((start, i) => {
    const end = weeks[i + 1] ?? new Date(8640000000000000);
    const inWeek = rows.filter((r) => {
      const t = new Date(r.at);
      return t >= start && t < end && r.scorecard.length === 5;
    });
    return {
      week: start.toLocaleDateString("en-US", { month: "numeric", day: "numeric" }),
      avg: inWeek.length ? inWeek.reduce((a, r) => a + score(r), 0) / inWeek.length : null,
      qualityPct: inWeek.length ? (inWeek.filter(isQuality).length / inWeek.length) * 100 : null,
      count: inWeek.length,
    };
  });
}

function lastWeeks(n: number): Date[] {
  const out: Date[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(periodStart("week", i));
  return out;
}

function GrowthChart({ series, metric }: { series: { name: string; color: string; points: WeekPoint[] }[]; metric: "avg" | "quality" }) {
  const W = 640;
  const H = 170;
  const PAD = { l: 34, r: 10, t: 10, b: 22 };
  const max = metric === "avg" ? 5 : 100;
  const n = series[0]?.points.length ?? 0;
  if (!n) return null;
  const x = (i: number) => PAD.l + (i / Math.max(n - 1, 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const val = (pt: WeekPoint) => (metric === "avg" ? pt.avg : pt.qualityPct);
  const hasAny = series.some((sr) => sr.points.some((pt) => val(pt) != null));
  if (!hasAny) return <div style={{ color: "var(--text-3)", fontSize: 13.5 }}>Not enough data yet — the line grows as weeks accumulate.</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 760, display: "block" }}>
        {metric === "avg" && (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(STANDARD_AVG)} y2={y(STANDARD_AVG)} stroke="var(--crit, #c9502e)" strokeWidth={1.2} strokeDasharray="5 4" opacity={0.7} />
            <text x={W - PAD.r - 2} y={y(STANDARD_AVG) - 4} textAnchor="end" fontSize={9.5} fill="var(--crit, #c9502e)">standard {STANDARD_AVG}</text>
          </g>
        )}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(f * max)} y2={y(f * max)} stroke="var(--border-soft, #2c2f35)" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(f * max) + 3.5} textAnchor="end" fontSize={9.5} fill="var(--text-3, #9aa0a6)">
              {metric === "avg" ? (f * max).toFixed(1) : `${Math.round(f * max)}%`}
            </text>
          </g>
        ))}
        {series[0].points.map((pt, i) =>
          i % 2 === 0 ? (
            <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize={9.5} fill="var(--text-3, #9aa0a6)">
              {pt.week}
            </text>
          ) : null
        )}
        {series.map((sr) => {
          const pts = sr.points
            .map((pt, i) => ({ i, v: val(pt), count: pt.count }))
            .filter((d) => d.v != null) as { i: number; v: number; count: number }[];
          if (!pts.length) return null;
          const path = pts.map((d, k) => `${k === 0 ? "M" : "L"}${x(d.i).toFixed(1)},${y(d.v).toFixed(1)}`).join(" ");
          return (
            <g key={sr.name}>
              <path d={path} fill="none" stroke={sr.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {pts.map((d) => (
                <circle key={d.i} cx={x(d.i)} cy={y(d.v)} r={3.2} fill={sr.color}>
                  <title>{`${sr.name} · wk of ${sr.points[d.i].week}: ${metric === "avg" ? d.v.toFixed(2) + "/5" : Math.round(d.v) + "%"} (${d.count} calls)`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      {series.length > 1 && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6 }}>
          {series.map((sr) => (
            <span key={sr.name} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text-2)" }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: sr.color, display: "inline-block" }} />
              {sr.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReviewsView({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<{
    reviews: Review[];
    patterns: any[];
    me: string | null;
    volume: { rep: string; at: string }[];
    rank: { rep: string; at: string; score: number | null }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("week");
  const [repSel, setRepSel] = useState<string | null>(null); // admin drill-down
  const [growthMetric, setGrowthMetric] = useState<"avg" | "quality">("avg");

  useEffect(() => {
    fetch("/api/reviews/stats")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  const all = data?.reviews ?? [];
  const reps = useMemo(
    () => [...new Set((data?.rank ?? []).map((r) => r.rep).filter(Boolean))].sort() as string[],
    [data]
  );
  const focusRep = isAdmin ? repSel : data?.me ?? null;
  const mine = useMemo(() => (focusRep ? all.filter((r) => r.rep === focusRep) : all), [all, focusRep]);

  const curStart = periodStart(period, 0);
  const prevStart = periodStart(period, 1);
  const cur = useMemo(() => aggregate(mine.filter((r) => new Date(r.at) >= curStart)), [mine, period]); // eslint-disable-line react-hooks/exhaustive-deps
  const prev = useMemo(
    () => aggregate(mine.filter((r) => new Date(r.at) >= prevStart && new Date(r.at) < curStart)),
    [mine, period] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const patterns = (data?.patterns ?? []).find((p: any) => p.rep === focusRep) ?? (!isAdmin ? (data?.patterns ?? [])[0] : null);

  // Volume curve: reviewed-call counts per rep in the current period, graded
  // against the leader. volPct = mine/leader; below VOLUME_CURVE = flagged.
  const volCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of data?.volume ?? []) {
      if (new Date(v.at) >= curStart) counts.set(v.rep, (counts.get(v.rep) ?? 0) + 1);
    }
    return counts;
  }, [data, period]); // eslint-disable-line react-hooks/exhaustive-deps
  const volLeader = [...volCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const volFor = (rep: string | null): { count: number; pct: number | null } => {
    const count = rep ? volCounts.get(rep) ?? 0 : [...volCounts.values()].reduce((a, b) => a + b, 0);
    if (!rep || !volLeader || volLeader[1] === 0) return { count, pct: null };
    return { count, pct: (count / volLeader[1]) * 100 };
  };
  const standing = (rep: string | null): { ok: boolean; reasons: string[] } | null => {
    if (!rep) return null;
    // Team rank rows (every role gets all reps') — the full review list only
    // holds the viewer's own reviews for non-admins.
    const rows = (data?.rank ?? []).filter((r) => r.rep === rep && new Date(r.at) >= curStart);
    const scored = rows.filter((r) => r.score != null) as { score: number }[];
    const avg = scored.length ? scored.reduce((a, r) => a + r.score, 0) / scored.length : null;
    const v = volFor(rep);
    const reasons: string[] = [];
    if (avg != null && avg < STANDARD_AVG) reasons.push(`avg ${avg.toFixed(1)} < ${STANDARD_AVG}`);
    if (v.pct != null && v.pct < VOLUME_CURVE * 100 && volLeader && rep !== volLeader[0])
      reasons.push(`volume ${v.count} vs leader ${volLeader[1]} (${Math.round(v.pct)}% < ${VOLUME_CURVE * 100}%)`);
    if (rows.length === 0 && volLeader && volLeader[1] > 0) reasons.push("no reviewed calls this period");
    return { ok: reasons.length === 0, reasons };
  };
  const myStanding = standing(focusRep);

  // ── Team leaderboard (public): rank-sum over quality / avg / volume ──────
  // Each metric ranked separately (competition ranking); final place = lowest
  // rank total. Two of three metrics are volume-driven, so a shiny average on
  // a handful of calls can't outrank steady volume (Kyle 9/10).
  const board = useMemo(() => {
    const rows = (data?.rank ?? []).filter((r) => new Date(r.at) >= curStart);
    const byRep = new Map<string, { count: number; quality: number; scoreSum: number; scored: number }>();
    for (const rep of reps) byRep.set(rep, { count: 0, quality: 0, scoreSum: 0, scored: 0 });
    for (const r of rows) {
      const b = byRep.get(r.rep);
      if (!b) continue;
      b.count++;
      if (r.score != null) {
        b.scored++;
        b.scoreSum += r.score;
        if (r.score >= 3.5) b.quality++;
      }
    }
    const entries = [...byRep.entries()].map(([rep, b]) => ({
      rep,
      count: b.count,
      quality: b.quality,
      avg: b.scored ? b.scoreSum / b.scored : null,
    }));
    const rankBy = (val: (e: (typeof entries)[number]) => number) => {
      const sorted = [...entries].sort((a, b) => val(b) - val(a));
      const rk = new Map<string, number>();
      sorted.forEach((e, i) => {
        // Competition ranking: equal values share the better rank.
        const prev = sorted[i - 1];
        rk.set(e.rep, prev && val(prev) === val(e) ? rk.get(prev.rep)! : i + 1);
      });
      return rk;
    };
    const rQ = rankBy((e) => e.quality);
    const rA = rankBy((e) => e.avg ?? -1);
    const rV = rankBy((e) => e.count);
    const placed = entries
      .map((e) => ({ ...e, rQ: rQ.get(e.rep)!, rA: rA.get(e.rep)!, rV: rV.get(e.rep)!, total: rQ.get(e.rep)! + rA.get(e.rep)! + rV.get(e.rep)! }))
      .sort(
        (a, b) =>
          a.total - b.total || b.quality - a.quality || (b.avg ?? -1) - (a.avg ?? -1) || b.count - a.count
      );
    return placed;
  }, [data, reps, period]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="viewsub">Couldn’t load reviews: {error}</div>;
  if (!data) return <div className="viewsub">Loading…</div>;

  const listRows = mine.filter((r) => new Date(r.at) >= curStart);

  return (
    <>
      <div className="viewhead">
        <h1>⚖ Call Reviews</h1>
      </div>
      <p className="viewsub">
        Every call over 5 minutes is reviewed automatically against the StoryBrand scorecard. A <b>quality call</b> scores
        3.5+ out of 5 (a hit = 1 point, a partial = half) — that&apos;s the number to move.
      </p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
          <button
            key={p}
            className={`btn ${period === p ? "primary" : "ghost"}`}
            style={{ padding: "6px 14px", fontSize: 13.5 }}
            onClick={() => setPeriod(p)}
          >
            {PERIOD_LABEL[p]}
          </button>
        ))}
        {isAdmin && (
          <select
            className="vmsel"
            style={{ width: "auto", marginLeft: "auto" }}
            value={repSel ?? ""}
            onChange={(e) => setRepSel(e.target.value || null)}
          >
            <option value="">Whole team</option>
            {reps.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        )}
      </div>

      {/* Standing banner */}
      {myStanding && (
        <div
          className="card"
          style={{
            padding: "10px 16px",
            marginBottom: 14,
            display: "flex",
            alignItems: "center",
            gap: 10,
            border: `1px solid ${myStanding.ok ? "var(--good, #3aa76d)" : "var(--crit, #c9502e)"}`,
          }}
        >
          <span style={{ fontSize: 20 }}>{myStanding.ok ? "✅" : "🚨"}</span>
          <div>
            <b style={{ fontSize: 14.5 }}>{myStanding.ok ? "At standard" : "Below standard"}</b>
            <span style={{ fontSize: 13, color: "var(--text-2)", marginLeft: 8 }}>
              {myStanding.ok
                ? `avg ≥ ${STANDARD_AVG}/5 and volume within ${Math.round(VOLUME_CURVE * 100)}% of the leader`
                : myStanding.reasons.join(" · ")}
            </span>
          </div>
        </div>
      )}

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 18 }}>
        <div className="card" style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Reviewed calls</div>
          <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{cur.count}</div>
          <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>prev: {prev.count}</div>
        </div>
        <div className="card" style={{ padding: "14px 16px", ...(cur.avg != null && cur.avg < STANDARD_AVG ? { border: "1px solid var(--crit, #c9502e)" } : {}) }}>
          <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Avg score</div>
          <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: cur.avg != null && cur.avg < STANDARD_AVG ? "var(--crit, #c9502e)" : undefined }}>
            {cur.avg != null ? cur.avg.toFixed(1) : "—"}<span style={{ fontSize: 15, color: "var(--text-3)" }}> / 5</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <TrendArrow cur={cur.avg} prev={prev.avg} />
            {cur.avg != null && cur.avg < STANDARD_AVG && (
              <span style={{ fontSize: 11.5, color: "var(--crit, #c9502e)", fontWeight: 700 }}>below standard (&lt;{STANDARD_AVG})</span>
            )}
          </div>
        </div>
        <div className="card" style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Quality calls (≥3.5/5)</div>
          <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
            {cur.quality}
            {cur.qualityPct != null && <span style={{ fontSize: 15, color: "var(--text-3)" }}> · {Math.round(cur.qualityPct)}%</span>}
          </div>
          <TrendArrow cur={cur.qualityPct} prev={prev.qualityPct} />
        </div>
        {(() => {
          const v = volFor(focusRep);
          const below = v.pct != null && v.pct < VOLUME_CURVE * 100 && !!volLeader && focusRep !== volLeader[0];
          return (
            <div className="card" style={{ padding: "14px 16px", ...(below ? { border: "1px solid var(--crit, #c9502e)" } : {}) }}>
              <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {focusRep ? "Volume vs leader" : "Leader volume"}
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: below ? "var(--crit, #c9502e)" : undefined }}>
                {focusRep && v.pct != null ? `${Math.round(v.pct)}%` : volLeader ? volLeader[1] : "—"}
              </div>
              <div style={{ fontSize: 12.5, color: below ? "var(--crit, #c9502e)" : "var(--text-3)" }}>
                {focusRep
                  ? volLeader
                    ? `${v.count} vs ${volLeader[1]} (${volLeader[0].split(" ")[0]})${below ? ` — below ${Math.round(VOLUME_CURVE * 100)}% curve` : ""}`
                    : `${v.count} reviewed`
                  : volLeader
                    ? `${volLeader[0]} sets this period's curve`
                    : "no reviews yet"}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Per-principle breakdown */}
      <div className="card" style={{ padding: "14px 16px", marginBottom: 18 }}>
        <div className="panel-h" style={{ marginTop: 0 }}>Scorecard breakdown — {PERIOD_LABEL[period].toLowerCase()} vs previous</div>
        {PRINCIPLES.map((p) => (
          <div key={p} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0" }}>
            <span style={{ width: 160, fontSize: 13.5 }}>{p}</span>
            <Bar v={cur.perPrinciple[p]} />
            <span style={{ width: 42, fontSize: 13, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
              {cur.perPrinciple[p] != null ? `${Math.round(cur.perPrinciple[p]! * 100)}%` : "—"}
            </span>
            <span style={{ width: 64 }}>
              <TrendArrow cur={cur.perPrinciple[p]} prev={prev.perPrinciple[p]} />
            </span>
          </div>
        ))}
        {cur.count === 0 && <div style={{ color: "var(--text-3)", fontSize: 13.5 }}>No reviewed calls in this period yet.</div>}
      </div>

      {/* Growth over time */}
      <div className="card" style={{ padding: "14px 16px", marginBottom: 18 }}>
        <div className="panel-h" style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 10 }}>
          📈 Growth — weekly, last 12 weeks
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
            <button
              className={`btn ${growthMetric === "avg" ? "primary" : "ghost"}`}
              style={{ padding: "3px 10px", fontSize: 12 }}
              onClick={() => setGrowthMetric("avg")}
            >
              Avg score
            </button>
            <button
              className={`btn ${growthMetric === "quality" ? "primary" : "ghost"}`}
              style={{ padding: "3px 10px", fontSize: 12 }}
              onClick={() => setGrowthMetric("quality")}
            >
              Quality %
            </button>
          </span>
        </div>
        <GrowthChart
          metric={growthMetric}
          series={(() => {
            const weeks = lastWeeks(12);
            if (isAdmin && !repSel) {
              return reps.map((rep, i) => ({
                name: rep,
                color: SERIES_COLORS[i % SERIES_COLORS.length],
                points: weeklySeries(all.filter((r) => r.rep === rep), weeks),
              }));
            }
            return [{ name: focusRep ?? "You", color: SERIES_COLORS[0], points: weeklySeries(mine, weeks) }];
          })()}
        />
      </div>

      {/* Team leaderboard — visible to every rep */}
      {board.length > 0 && (
        <div className="card" style={{ padding: "14px 16px", marginBottom: 18, overflowX: "auto" }}>
          <div className="panel-h" style={{ marginTop: 0 }}>🏆 Team ranking — {PERIOD_LABEL[period].toLowerCase()}</div>
          <table className="data" style={{ fontSize: 13.5 }}>
            <thead>
              <tr>
                <th>Place</th>
                <th>Rep</th>
                <th title="Calls scoring ≥3.5/5 — skill">Quality calls</th>
                <th title="Average score — consistency">Avg /5</th>
                <th title="Calls reviewed — activity">Reviews</th>
                <th title="Reviewed calls vs the period leader">Vol %</th>
                <th>Standing</th>
              </tr>
            </thead>
            <tbody>
              {board.map((e, i) => {
                const medal = i === 0 ? "🥇 1st" : i === 1 ? "🥈 2nd" : i === 2 ? "🥉 3rd" : `${i + 1}th`;
                const v = volFor(e.rep);
                const st = standing(e.rep);
                const me = e.rep === (data?.me ?? "");
                return (
                  <tr
                    key={e.rep}
                    style={{ cursor: isAdmin ? "pointer" : "default", background: me ? "var(--accent-soft, rgba(79,124,255,0.08))" : undefined }}
                    onClick={() => isAdmin && setRepSel(e.rep)}
                    title={isAdmin ? "Click to drill in" : undefined}
                  >
                    <td style={{ fontWeight: 800, whiteSpace: "nowrap" }}>{medal}</td>
                    <td style={{ fontWeight: me ? 800 : 600 }}>{e.rep}{me ? " (you)" : ""}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{e.quality} <span style={{ color: "var(--text-3)", fontSize: 11.5 }}>#{e.rQ}</span></td>
                    <td style={{ fontVariantNumeric: "tabular-nums", color: e.avg != null && e.avg < STANDARD_AVG ? "var(--crit, #c9502e)" : undefined }}>
                      {e.avg != null ? e.avg.toFixed(1) : "—"} <span style={{ color: "var(--text-3)", fontSize: 11.5 }}>#{e.rA}</span>
                    </td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{e.count} <span style={{ color: "var(--text-3)", fontSize: 11.5 }}>#{e.rV}</span></td>
                    <td style={{ fontVariantNumeric: "tabular-nums", color: v.pct != null && v.pct < VOLUME_CURVE * 100 ? "var(--crit, #c9502e)" : undefined }}>
                      {v.pct != null ? `${Math.round(v.pct)}%` : "—"}
                    </td>
                    <td title={st && !st.ok ? st.reasons.join(" · ") : undefined}>{st ? (st.ok ? "✅" : "🚨") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 6 }}>
            Place = best combined ranking across the three columns (#) — quality calls (skill), average score
            (consistency), and reviews (activity). Two of the three reward volume, so a high average on a few calls
            won&apos;t outrank steady output. Ties break by quality calls, then average.
          </div>
        </div>
      )}

      {/* Qualitative patterns */}
      {patterns && (
        <div className="card" style={{ padding: "14px 16px", marginBottom: 18 }}>
          <div className="panel-h" style={{ marginTop: 0 }}>🧑‍🏫 Coaching patterns{focusRep ? ` — ${focusRep}` : ""}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, fontSize: 13.5 }}>
            <div>
              <div style={{ fontWeight: 700, color: "var(--good, #3aa76d)", marginBottom: 4 }}>Working</div>
              {(patterns.patterns?.strengths ?? []).map((s: string, i: number) => (
                <div key={i} style={{ padding: "2px 0" }} dangerouslySetInnerHTML={{ __html: mdLite(s) }} />
              ))}
            </div>
            <div>
              <div style={{ fontWeight: 700, color: "#d99a2b", marginBottom: 4 }}>Recurring gaps</div>
              {(patterns.patterns?.gaps ?? []).map((s: string, i: number) => (
                <div key={i} style={{ padding: "2px 0" }} dangerouslySetInnerHTML={{ __html: mdLite(s) }} />
              ))}
            </div>
            {patterns.patterns?.coaching_focus && (
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>🎯 Focus</div>
                <div dangerouslySetInnerHTML={{ __html: mdLite(patterns.patterns.coaching_focus) }} />
              </div>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 8 }}>
            Synthesized from reviews over the last {patterns.window_days ?? 90} days · updated {String(patterns.updated_at ?? "").slice(0, 10)}
          </div>
        </div>
      )}

      {/* Reviewed calls list */}
      <div className="card" style={{ padding: "14px 16px" }}>
        <div className="panel-h" style={{ marginTop: 0 }}>
          Reviewed calls — {PERIOD_LABEL[period].toLowerCase()}{focusRep ? ` · ${focusRep}` : ""}
        </div>
        {listRows.length === 0 && <div style={{ color: "var(--text-3)", fontSize: 13.5 }}>None in this period.</div>}
        {listRows.map((r) => (
          <div key={r.id} style={{ borderTop: "1px solid var(--border-soft, #2c2f35)", padding: "10px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>
                {new Date(r.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
              {isAdmin && !focusRep && r.rep && <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>{r.rep}</span>}
              {r.dealId ? (
                <Link href={`/crm/deal/${r.dealId}`} style={{ fontWeight: 600, fontSize: 14 }}>
                  {r.dealTitle ?? "Open deal"}
                </Link>
              ) : (
                <span style={{ fontWeight: 600, fontSize: 14 }}>{r.dealTitle ?? "—"}</span>
              )}
              <span style={{ display: "inline-flex", gap: 4, marginLeft: "auto" }} title={r.scorecard.map((s) => `${s.principle}: ${s.verdict}`).join("\n")}>
                {r.scorecard.map((s, i) => (
                  <span key={i} style={{ width: 10, height: 10, borderRadius: "50%", background: VERDICT_DOT[s.verdict] ?? "var(--surface-3)" }} />
                ))}
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums", width: 46, textAlign: "right" }}>
                {r.scorecard.length === 5 ? `${score(r).toFixed(1)}/5` : "—"}
              </span>
            </div>
            {r.snapshot && <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 4 }}>{r.snapshot}</div>}
            {r.thin && <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>thin transcript — high-level review only</div>}
          </div>
        ))}
      </div>
    </>
  );
}

/** **bold** / *italic* → HTML (values come from our own AI tool output). */
function mdLite(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>");
}
