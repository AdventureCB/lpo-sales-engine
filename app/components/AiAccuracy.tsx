"use client";

import { useEffect, useState } from "react";

interface Report {
  days: number;
  totals: {
    closed: number;
    profiled: number;
    unprofiled: number;
    winRateProfiled: number | null;
    winRateUnprofiled: number | null;
    avgConfWon: number | null;
    avgConfLost: number | null;
  };
  archetypes: { key: string; name: string; closed: number; won: number; winRate: number | null; wonValueCents: number; topLostReason: string | null }[];
  calibration: { label: string; n: number; won: number }[];
  corrections: { corrected: { n: number; won: number }; untouched: { n: number; won: number } };
}

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;

/** Phase 5b: how the profiler's reads line up with actual outcomes. */
export function AiAccuracy() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState<Report | null>(null);

  useEffect(() => {
    fetch(`/api/admin/ai-accuracy?days=${days}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => {});
  }, [days]);

  if (!data) return null;
  const t = data.totals;
  const small = (n: number) => n > 0 && n < 10;

  return (
    <div className="card" style={{ maxWidth: 680, marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>🧠 AI accuracy</h3>
        <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>profiles frozen at close vs what actually happened</span>
        <div className="range-toggle" style={{ marginBottom: 0, marginLeft: "auto" }}>
          {[30, 90, 180].map((d) => (
            <button key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>{d}d</button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, margin: "14px 0" }}>
        <div className="stat-tile"><div className="n">{t.profiled}<span style={{ fontSize: 13, color: "var(--text-3)" }}>/{t.closed}</span></div><div className="l">Closed w/ profile</div></div>
        <div className="stat-tile"><div className="n">{pct(t.winRateProfiled)}</div><div className="l">Win rate (profiled)</div><div className="d">vs {pct(t.winRateUnprofiled)} unprofiled</div></div>
        <div className="stat-tile"><div className="n">{pct(t.avgConfWon)}</div><div className="l">Avg confidence on wins</div></div>
        <div className="stat-tile"><div className="n">{pct(t.avgConfLost)}</div><div className="l">Avg confidence on losses</div></div>
      </div>

      {t.profiled === 0 ? (
        <div style={{ fontSize: 13, color: "var(--text-3)" }}>
          No profiled deals have closed in this window yet — numbers accumulate as deals with profiles resolve.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)", margin: "6px 0" }}>
            By dominant archetype
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-3)", fontSize: 11.5 }}>
                  {["Archetype", "Closed", "Won", "Win rate", "Won value", "Top lost reason"].map((h) => (
                    <th key={h} style={{ padding: "6px 10px", borderBottom: "1px solid var(--border-soft)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.archetypes.map((a) => (
                  <tr key={a.key} style={{ borderBottom: "1px solid var(--border-soft)" }}>
                    <td style={{ padding: "6px 10px", fontWeight: 650 }}>{a.name}{small(a.closed) && <span title="Small sample — directional only" style={{ color: "var(--warn)", marginLeft: 4 }}>*</span>}</td>
                    <td style={{ padding: "6px 10px", fontVariantNumeric: "tabular-nums" }}>{a.closed}</td>
                    <td style={{ padding: "6px 10px", fontVariantNumeric: "tabular-nums" }}>{a.won}</td>
                    <td style={{ padding: "6px 10px", fontVariantNumeric: "tabular-nums", fontWeight: 650, color: (a.winRate ?? 0) >= 0.3 ? "var(--good)" : undefined }}>{pct(a.winRate)}</td>
                    <td style={{ padding: "6px 10px", fontVariantNumeric: "tabular-nums" }}>{usd(a.wonValueCents)}</td>
                    <td style={{ padding: "6px 10px", color: "var(--text-3)" }}>{a.topLostReason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)", margin: "16px 0 6px" }}>
            Is confidence honest? (win rate by stated confidence)
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            {data.calibration.map((b) => {
              const wr = b.n ? b.won / b.n : null;
              return (
                <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ width: 64, color: "var(--text-2)", fontVariantNumeric: "tabular-nums" }}>{b.label}</span>
                  <div style={{ flex: 1, height: 13, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ width: `${(wr ?? 0) * 100}%`, height: "100%", background: "var(--accent)", borderRadius: 4 }} />
                  </div>
                  <span style={{ width: 42, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 650 }}>{pct(wr)}</span>
                  <span style={{ width: 56, textAlign: "right", fontSize: 11.5, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>n={b.n}</span>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 4 }}>
            Honest confidence = bars step up left to right. Flat bars mean the confidence number carries no signal.
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)", margin: "16px 0 6px" }}>
            Do corrections help?
          </div>
          <div style={{ display: "flex", gap: 18, fontSize: 13, flexWrap: "wrap" }}>
            <span>
              Rep-corrected: <b>{pct(data.corrections.corrected.n ? data.corrections.corrected.won / data.corrections.corrected.n : null)}</b>{" "}
              <span style={{ color: "var(--text-3)" }}>win rate (n={data.corrections.corrected.n})</span>
            </span>
            <span>
              Untouched: <b>{pct(data.corrections.untouched.n ? data.corrections.untouched.won / data.corrections.untouched.n : null)}</b>{" "}
              <span style={{ color: "var(--text-3)" }}>win rate (n={data.corrections.untouched.n})</span>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
