"use client";

import { useCallback, useEffect, useState } from "react";

interface Hyp {
  id: string;
  claim: string;
  rationale: string | null;
  category: string | null;
  cohort: { feature: string; op: string; value?: unknown }[];
  outcome: string;
  direction: string;
  status: string;
  backtest: { cohort_n: number; cohort_hits: number; base_n: number; base_hits: number; lift: number; z: number } | null;
  prospective: { cohort_n: number; cohort_hits: number; base_n: number; base_hits: number };
  prospective_z: number | null;
  human_approved: boolean;
  registered_at: string | null;
  created_at: string;
}

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  registered: { label: "⏳ Registered — proving", color: "#b58a2e" },
  validated: { label: "✅ Validated", color: "#3aa76d" },
  retired: { label: "🪦 Retired", color: "var(--text-3)" },
  rejected: { label: "✗ Failed backtest", color: "var(--text-3)" },
  proposed: { label: "Proposed", color: "var(--text-2)" },
};

const pct = (h: number, n: number) => (n ? `${((h / n) * 100).toFixed(1)}%` : "—");

// Φ(z) — standard normal CDF via erf approximation (Abramowitz-Stegun).
function phi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** Certainty the FUTURE agrees with the claim, from prospective evidence only. */
function certainty(h: Hyp): { pct: number; n: number } {
  const z = h.prospective_z;
  const n = h.prospective.cohort_n;
  if (z == null || n === 0) return { pct: 0, n: 0 };
  const dirZ = h.direction === "lower" ? -z : z;
  return { pct: Math.round(phi(dirZ) * 100), n };
}

export function HypothesesView() {
  const [data, setData] = useState<{ hypotheses: Hyp[]; snapshot: { deals: number; at: string | null } } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showDead, setShowDead] = useState(false);

  const load = useCallback(() => {
    fetch("/api/admin/hypotheses")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(load, [load]);

  const post = async (op: string, id?: string) => {
    setBusy(op + (id ?? ""));
    setErr(null);
    try {
      const r = await fetch("/api/admin/hypotheses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const hyps = (data?.hypotheses ?? []).filter((h) => showDead || !["rejected", "retired"].includes(h.status));
  const dead = (data?.hypotheses ?? []).length - (data?.hypotheses ?? []).filter((h) => !["rejected", "retired"].includes(h.status)).length;

  return (
    <div className="card" style={{ maxWidth: 980 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>🔬 Outcome hypotheses</h3>
        <span className="viewsub" style={{ margin: 0 }}>
          {data ? `${data.snapshot.deals.toLocaleString()} closed deals in the snapshot` : "…"}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" disabled={busy !== null} onClick={() => post("score")}>
          {busy === "score" ? "Scoring…" : "⚖ Score now"}
        </button>
        <button className="btn" disabled={busy !== null} onClick={() => post("generate")}>
          {busy === "generate" ? "Generating…" : "✨ Generate hypotheses"}
        </button>
      </div>
      <p className="viewsub" style={{ marginTop: 6 }}>
        The AI proposes falsifiable pathway-to-outcome claims over every closed deal. Backtest survivors are
        <b> registered</b>, then judged only on deals that close <i>afterward</i> — fitting history is easy, predicting
        the future is the test. <b>Approve</b> marks a hypothesis eligible to steer scripts/drafts/next-actions once
        that layer ships; nothing rep-facing happens without it.
      </p>
      {err && <p className="viewsub" style={{ color: "var(--crit)" }}>{err}</p>}

      <div style={{ display: "grid", gap: 10 }}>
        {hyps.map((h) => {
          const b = h.backtest;
          const p = h.prospective;
          const badge = STATUS_BADGE[h.status] ?? STATUS_BADGE.proposed;
          return (
            <div key={h.id} style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: "10px 14px" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <b style={{ fontSize: 14.5 }}>{h.claim}</b>
                <span style={{ fontSize: 12.5, color: badge.color, whiteSpace: "nowrap" }}>{badge.label}</span>
                {h.human_approved && <span style={{ fontSize: 12.5, color: "#3aa76d" }}>· 👍 approved to steer</span>}
              </div>
              {h.rationale && (
                <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 2 }}>{h.rationale}</div>
              )}
              <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 6, display: "flex", gap: 14, flexWrap: "wrap" }}>
                <span>
                  outcome <b>{h.outcome}</b> · {h.direction} · {h.category}
                </span>
                {b && (
                  <span>
                    backtest: cohort {pct(b.cohort_hits, b.cohort_n)} (n={b.cohort_n}) vs base {pct(b.base_hits, b.base_n)} · z={b.z?.toFixed(1)}
                  </span>
                )}
                <span>
                  since registration: {p.cohort_n > 0 ? `cohort ${pct(p.cohort_hits, p.cohort_n)} (n=${p.cohort_n}) vs base ${pct(p.base_hits, p.base_n)}${h.prospective_z != null ? ` · z=${h.prospective_z.toFixed(1)}` : ""}` : "no closes yet"}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4 }}>
                cohort: {h.cohort.map((c) => `${c.feature} ${c.op}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ""}`).join(" AND ")}
              </div>
              {!["rejected", "retired"].includes(h.status) && (() => {
                const c = certainty(h);
                const thin = c.n < 10;
                const color = thin ? "var(--text-3)" : c.pct >= 90 ? "#3aa76d" : c.pct >= 60 ? "#b58a2e" : "#c05555";
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7, maxWidth: 420 }}>
                    <span style={{ fontSize: 11.5, color: "var(--text-3)", whiteSpace: "nowrap" }}>certainty</span>
                    <div style={{ flex: 1, height: 7, borderRadius: 4, background: "var(--bg-2)", border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                      <div style={{ width: `${c.n === 0 ? 0 : c.pct}%`, height: "100%", background: color, opacity: thin ? 0.45 : 1 }} />
                    </div>
                    <span style={{ fontSize: 11.5, color: thin ? "var(--text-3)" : color, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                      {c.n === 0 ? "awaiting closes" : `${c.pct}%${thin ? ` · only ${c.n} closes` : ""}`}
                    </span>
                  </div>
                );
              })()}
              {!["rejected", "retired"].includes(h.status) && (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button
                    className="btn ghost"
                    style={{ padding: "2px 10px", fontSize: 12 }}
                    disabled={busy !== null}
                    onClick={() => post(h.human_approved ? "unapprove" : "approve", h.id)}
                  >
                    {h.human_approved ? "Withdraw approval" : "👍 Approve to steer"}
                  </button>
                  <button
                    className="btn ghost"
                    style={{ padding: "2px 10px", fontSize: 12 }}
                    disabled={busy !== null}
                    onClick={() => post("retire", h.id)}
                  >
                    🪦 Retire
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {data && hyps.length === 0 && (
          <p className="viewsub">No hypotheses yet — build the snapshot, then hit ✨ Generate.</p>
        )}
      </div>
      {dead > 0 && (
        <button className="btn ghost" style={{ marginTop: 10, fontSize: 12.5 }} onClick={() => setShowDead((v) => !v)}>
          {showDead ? "Hide" : "Show"} {dead} rejected/retired
        </button>
      )}
    </div>
  );
}
