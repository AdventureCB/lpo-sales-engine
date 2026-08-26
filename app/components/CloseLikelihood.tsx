"use client";

import { useEffect, useState } from "react";

interface Score {
  probability: number;
  base: number;
  factors: { claim: string; direction: string; shift: number; status: string }[];
}

/**
 * Admin-only indicative close-likelihood chip (self-gating: the endpoint
 * 403s for reps and the component renders nothing). Hypothesis-driven —
 * expandable to show which registered/validated patterns moved the number.
 */
export function CloseLikelihood({ dealId }: { dealId: string }) {
  const [score, setScore] = useState<Score | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/admin/close-score?dealId=${dealId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && !d.error && setScore(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [dealId]);

  if (!score) return null;
  const pct = Math.round(score.probability * 100);
  const basePct = Math.round(score.base * 100);
  const color = pct >= 45 ? "#3aa76d" : pct >= 20 ? "#b58a2e" : "var(--text-3)";

  return (
    <div className="card" style={{ padding: "10px 14px" }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
        title="Hypothesis-driven estimate — admin-only while the system earns trust"
      >
        <span style={{ fontSize: 15 }}>🎯</span>
        <b style={{ fontSize: 14 }}>Close likelihood</b>
        <span style={{ fontWeight: 800, color, fontSize: 15, fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
        <span style={{ fontSize: 12, color: "var(--text-3)" }}>
          base {basePct}% · {score.factors.length} factor{score.factors.length === 1 ? "" : "s"} · indicative
        </span>
        <span style={{ marginLeft: "auto", color: "var(--text-3)" }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
          {score.factors.length === 0 && (
            <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>No active hypotheses match this deal yet.</span>
          )}
          {score.factors.map((f, i) => (
            <div key={i} style={{ fontSize: 12.5, display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ color: f.shift >= 0 ? "#3aa76d" : "#c05555", fontVariantNumeric: "tabular-nums", minWidth: 44, fontWeight: 700 }}>
                {f.shift >= 0 ? "+" : ""}{f.shift}
              </span>
              <span style={{ color: "var(--text-2)" }}>{f.claim}</span>
              {f.status === "validated" && <span style={{ color: "#3aa76d", fontSize: 11 }}>✓</span>}
            </div>
          ))}
          <span style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 2 }}>
            Log-odds shifts from registered/validated hypotheses this deal matches; overlapping factors are clamped. Trust grows with each hypothesis&apos;s certainty bar.
          </span>
        </div>
      )}
    </div>
  );
}
