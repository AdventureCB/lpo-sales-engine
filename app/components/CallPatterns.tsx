"use client";

import { useEffect, useState } from "react";
import { em, asLines } from "./CallReviewCard";

interface PatternRow {
  rep: string;
  review_count: number;
  window_days: number;
  patterns: {
    strengths?: string[];
    gaps?: string[];
    coaching_focus?: string;
    scorecard_tallies?: Record<string, { hit: number; partial: number; missed: number }>;
  };
  updated_at: string;
}

/**
 * 🧑‍🏫 Rep call patterns — recurring strengths/gaps per rep, synthesized from
 * stored ⚖ call reviews. Pre-built ahead of need: it stays thin until reps
 * accumulate reviews (and gets much sharper on full post-port transcripts).
 */
export function CallPatterns() {
  const [rows, setRows] = useState<PatternRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await fetch("/api/admin/call-patterns");
      const d = await r.json();
      if (r.ok) {
        setRows(d.patterns ?? []);
        setCounts(d.counts ?? {});
        setTotal(d.totalReviews90d ?? 0);
      }
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/admin/call-patterns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      const ran = (d.results ?? []).filter((x: any) => x.ran).length;
      const skipped = (d.results ?? []).filter((x: any) => !x.ran);
      setMsg(`✓ Analyzed ${ran} rep${ran === 1 ? "" : "s"}${skipped.length ? ` · skipped ${skipped.map((s: any) => `${s.rep} (${s.reason})`).join(", ")}` : ""}`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 980, marginTop: 18 }}>
      <div className="panel-h" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        🧑‍🏫 Rep call patterns
        <span style={{ fontWeight: 400, fontSize: 12.5, color: "var(--text-3)" }}>{total} reviewed call{total === 1 ? "" : "s"} in 90d</span>
        <button className="btn" style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 13 }} disabled={busy} onClick={() => void run()}>
          {busy ? "Analyzing…" : "▶ Analyze patterns"}
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-3)", marginBottom: 10 }}>
        Recurring coaching patterns per rep, synthesized from ⚖ call reviews (a rep needs 3+ reviewed calls). Reviews are created from the deal timeline —
        expand a call with a transcript and press <b>⚖ Review call</b>.
        {msg && <span style={{ marginLeft: 8, color: msg.startsWith("✓") ? "var(--good)" : "var(--crit)" }}>{msg}</span>}
      </div>

      {loading && <div style={{ color: "var(--text-3)", fontSize: 13 }}>Loading…</div>}
      {!loading && rows.length === 0 && (
        <div style={{ color: "var(--text-3)", fontSize: 13.5 }}>
          No patterns yet{total > 0 ? ` — ${total} review${total === 1 ? "" : "s"} stored so far${Object.keys(counts).length ? ` (${Object.entries(counts).map(([r, n]) => `${r}: ${n}`).join(", ")})` : ""}. Run the analysis once a rep has 3+.` : ". Reviews accumulate as reps use ⚖ Review call on transcripts."}
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {rows.map((row) => {
          const t = row.patterns.scorecard_tallies ?? {};
          return (
            <div key={row.rep} style={{ background: "var(--surface-2)", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <b style={{ fontSize: 14.5 }}>{row.rep}</b>
                <span style={{ fontSize: 12, color: "var(--text-3)" }}>
                  {row.review_count} call{row.review_count === 1 ? "" : "s"} · last {row.window_days}d · updated {new Date(row.updated_at).toLocaleDateString()}
                </span>
              </div>

              {Object.keys(t).length > 0 && (
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", margin: "8px 0 2px" }}>
                  {Object.entries(t).map(([principle, v]) => {
                    const n = v.hit + v.partial + v.missed || 1;
                    return (
                      <div key={principle} style={{ fontSize: 12, minWidth: 130 }}>
                        <div style={{ color: "var(--text-3)", marginBottom: 2 }}>{principle}</div>
                        <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "var(--border-soft)" }}>
                          <span style={{ width: `${(v.hit / n) * 100}%`, background: "var(--good)" }} />
                          <span style={{ width: `${(v.partial / n) * 100}%`, background: "var(--text-3)" }} />
                          <span style={{ width: `${(v.missed / n) * 100}%`, background: "var(--crit)" }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginTop: 8 }}>
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--good)", marginBottom: 4 }}>Strengths</div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--text-2)", display: "grid", gap: 3 }}>
                    {asLines(row.patterns.strengths).map((s, i) => (
                      <li key={i}>{em(s)}</li>
                    ))}
                    {asLines(row.patterns.strengths).length === 0 && <li style={{ color: "var(--text-3)" }}>None recurring yet.</li>}
                  </ul>
                </div>
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--crit)", marginBottom: 4 }}>Gaps</div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--text-2)", display: "grid", gap: 3 }}>
                    {asLines(row.patterns.gaps).map((g, i) => (
                      <li key={i}>{em(g)}</li>
                    ))}
                    {asLines(row.patterns.gaps).length === 0 && <li style={{ color: "var(--text-3)" }}>None recurring yet.</li>}
                  </ul>
                </div>
              </div>

              {row.patterns.coaching_focus && (
                <div style={{ marginTop: 10, fontSize: 13, color: "var(--text-2)", borderTop: "1px solid var(--border-soft)", paddingTop: 8 }}>
                  <b style={{ color: "var(--accent)" }}>Coaching focus:</b> {em(row.patterns.coaching_focus)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
