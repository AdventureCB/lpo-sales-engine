"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

/**
 * ⚖ Reviews dashboard — the leading-KPI view over AI call reviews.
 * Every call ≥5min is auto-reviewed (ai-refresh cron mode=reviews); this
 * page turns the stored scorecards into daily/weekly/monthly stats:
 * average score per StoryBrand principle, trend vs the prior period, and
 * "quality calls" (4+ of 5 principles hit). Reps see themselves; admins
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
function hits(r: Review): number {
  return r.scorecard.filter((x) => x.verdict === "hit").length;
}

interface Agg {
  count: number;
  avg: number | null; // 0-5
  quality: number; // calls with 4+ hits
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
  const quality = scored.filter((r) => hits(r) >= 4).length;
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

export function ReviewsView({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<{ reviews: Review[]; patterns: any[]; me: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("week");
  const [repSel, setRepSel] = useState<string | null>(null); // admin drill-down

  useEffect(() => {
    fetch("/api/reviews/stats")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  const all = data?.reviews ?? [];
  const reps = useMemo(() => [...new Set(all.map((r) => r.rep).filter(Boolean))].sort() as string[], [all]);
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

  if (error) return <div className="viewsub">Couldn’t load reviews: {error}</div>;
  if (!data) return <div className="viewsub">Loading…</div>;

  const listRows = mine.filter((r) => new Date(r.at) >= curStart);

  return (
    <>
      <div className="viewhead">
        <h1>⚖ Call Reviews</h1>
      </div>
      <p className="viewsub">
        Every call over 5 minutes is reviewed automatically against the StoryBrand scorecard. A <b>quality call</b> hits
        4+ of the 5 principles — that&apos;s the number to move.
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

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 18 }}>
        <div className="card" style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Reviewed calls</div>
          <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{cur.count}</div>
          <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>prev: {prev.count}</div>
        </div>
        <div className="card" style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Avg score</div>
          <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
            {cur.avg != null ? cur.avg.toFixed(1) : "—"}<span style={{ fontSize: 15, color: "var(--text-3)" }}> / 5</span>
          </div>
          <TrendArrow cur={cur.avg} prev={prev.avg} />
        </div>
        <div className="card" style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Quality calls (4+ hits)</div>
          <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
            {cur.quality}
            {cur.qualityPct != null && <span style={{ fontSize: 15, color: "var(--text-3)" }}> · {Math.round(cur.qualityPct)}%</span>}
          </div>
          <TrendArrow cur={cur.qualityPct} prev={prev.qualityPct} />
        </div>
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

      {/* Admin: group comparison */}
      {isAdmin && !repSel && reps.length > 0 && (
        <div className="card" style={{ padding: "14px 16px", marginBottom: 18, overflowX: "auto" }}>
          <div className="panel-h" style={{ marginTop: 0 }}>Rep comparison — {PERIOD_LABEL[period].toLowerCase()}</div>
          <table className="data" style={{ fontSize: 13.5 }}>
            <thead>
              <tr>
                <th>Rep</th>
                <th>Reviews</th>
                <th>Avg /5</th>
                <th>Quality</th>
                {PRINCIPLES.map((p) => (
                  <th key={p}>{SHORT[p]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reps.map((rep) => {
                const a = aggregate(all.filter((r) => r.rep === rep && new Date(r.at) >= curStart));
                return (
                  <tr key={rep} style={{ cursor: "pointer" }} onClick={() => setRepSel(rep)} title="Click to drill in">
                    <td style={{ fontWeight: 600 }}>{rep}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{a.count}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{a.avg != null ? a.avg.toFixed(1) : "—"}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>
                      {a.quality}{a.qualityPct != null ? ` (${Math.round(a.qualityPct)}%)` : ""}
                    </td>
                    {PRINCIPLES.map((p) => (
                      <td key={p} style={{ fontVariantNumeric: "tabular-nums" }}>
                        {a.perPrinciple[p] != null ? `${Math.round(a.perPrinciple[p]! * 100)}%` : "—"}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
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
