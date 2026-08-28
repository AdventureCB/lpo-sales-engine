"use client";

import React, { useState } from "react";

interface ScoreRow {
  principle: string;
  verdict: "hit" | "partial" | "missed";
  note: string;
}
interface Review {
  snapshot: string;
  worked?: string[];
  scorecard: ScoreRow[];
  do_differently?: { moment: string; try: string }[];
  next_move: string;
  thin_transcript?: boolean;
}

/** Inline emphasis from the model's markers: **bold** key words, *italics* = spoken lines. */
export const em = (raw: string | null | undefined): React.ReactNode[] => {
  const text = String(raw ?? "");
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<b key={i++} style={{ color: "var(--text-1)" }}>{tok.slice(2, -2)}</b>);
    else parts.push(<i key={i++} style={{ color: "var(--accent-2, var(--text-2))" }}>{tok.slice(1, -1)}</i>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
};

// Model list fields can arrive malformed (string instead of array) — coerce.
export const asLines = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)) : v == null || v === "" ? [] : [String(v)];
const asObjects = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v.filter((o) => o && typeof o === "object") as T[]) : []);

const VERDICT: Record<string, { icon: string; color: string; label: string }> = {
  hit: { icon: "✓", color: "var(--good)", label: "hit" },
  partial: { icon: "◐", color: "var(--text-2)", label: "partial" },
  missed: { icon: "✗", color: "var(--crit)", label: "missed" },
};

/**
 * ⚖ Review call — StoryBrand coaching on one transcript, rendered inline
 * under the expanded timeline entry. Generation is manual (button press) and
 * server-cached, so "View call review" on an already-reviewed call is free.
 */
export function CallReviewInline({
  dealId,
  activityId,
  callId,
  reviewed,
}: {
  dealId: string;
  activityId: string | null;
  callId: string | null;
  reviewed: boolean;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (force = false) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/ai/call-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId, activityId: activityId ?? undefined, callId: callId ?? undefined, force }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      setReview(d.review);
      setOpen(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const Section = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 8 }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-2)" }}>{children}</div>
    </div>
  );

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="btn ghost"
          style={{ padding: "2px 10px", fontSize: 12 }}
          disabled={busy}
          onClick={() => (review && open ? setOpen(false) : review ? setOpen(true) : void run())}
        >
          {busy ? "Reviewing…" : review ? (open ? "▲ Hide review" : "⚖ Show review") : reviewed ? "⚖ View call review" : "⚖ Review call"}
        </button>
        {err && <span style={{ color: "var(--crit)", fontSize: 12 }}>{err}</span>}
      </div>

      {review && open && (
        <div style={{ background: "var(--surface-2)", borderRadius: 8, padding: "10px 12px", marginTop: 8, display: "grid", gap: 8, maxWidth: 640 }}>
          {review.thin_transcript && (
            <div style={{ fontSize: 12, color: "var(--text-3)", fontStyle: "italic" }}>
              Summary-only transcript — high-level feedback. This was an older call; calls placed in the app now carry full transcripts and get sharper reviews.
            </div>
          )}
          <div style={{ fontSize: 13.5, lineHeight: 1.5, color: "var(--text-1)" }}>{em(review.snapshot)}</div>

          {asLines(review.worked).length > 0 && (
            <Section label="👍 What worked">
              <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 3 }}>
                {asLines(review.worked).map((w, i) => (
                  <li key={i}>{em(w)}</li>
                ))}
              </ul>
            </Section>
          )}

          <Section label="📖 StoryBrand scorecard">
            <div style={{ display: "grid", gap: 4 }}>
              {asObjects<ScoreRow>(review.scorecard).map((s, i) => {
                const v = VERDICT[s.verdict] ?? VERDICT.partial;
                return (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ color: v.color, fontWeight: 700, width: 14, flexShrink: 0 }}>{v.icon}</span>
                    <span style={{ minWidth: 0 }}>
                      <b style={{ color: "var(--text-1)" }}>{s.principle}</b>
                      <span style={{ color: v.color, fontSize: 12, marginLeft: 6 }}>{v.label}</span>
                      <span style={{ color: "var(--text-3)" }}> — </span>
                      {em(s.note)}
                    </span>
                  </div>
                );
              })}
            </div>
          </Section>

          {asObjects<{ moment: string; try: string }>(review.do_differently).length > 0 && (
            <Section label="🔁 Do differently">
              <div style={{ display: "grid", gap: 5 }}>
                {asObjects<{ moment: string; try: string }>(review.do_differently).map((d, i) => (
                  <div key={i}>
                    {em(d.moment)}
                    <span style={{ color: "var(--text-3)" }}> → </span>
                    {em(d.try)}
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section label="🎯 Suggested next move">{em(review.next_move)}</Section>

          <div>
            <button className="btn ghost" style={{ padding: "2px 10px", fontSize: 12 }} disabled={busy} onClick={() => void run(true)}>
              ↻ Re-review
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
