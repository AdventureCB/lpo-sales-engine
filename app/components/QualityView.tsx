"use client";

import { useCallback, useEffect, useState } from "react";

/** Call-quality dashboard: per-rep averages, click a rep for their last 50. */

interface RepSummary {
  rep: string;
  repId: string;
  calls: number;
  avgLossPct: number;
  avgMaxJitterMs: number;
  avgMos: number | null;
}

interface CallRow {
  at: string;
  durationS: number | null;
  disposition: string | null;
  avgLossPct: number | null;
  maxJitterMs: number | null;
  mos: number | null;
}

function grade(loss: number, jitter: number): { label: string; color: string } {
  if (loss < 1 && jitter < 30) return { label: "Excellent", color: "var(--ok, #0ca30c)" };
  if (loss < 3 && jitter < 60) return { label: "Good", color: "var(--warn, #fab219)" };
  return { label: "Poor", color: "var(--crit)" };
}

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function QualityView() {
  const [summary, setSummary] = useState<RepSummary[] | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [active, setActive] = useState<RepSummary | null>(null);
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/quality")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          setSummary(d.summary);
          setWindowDays(d.windowDays ?? 30);
        })
        .catch((e) => setError(String(e))),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);

  const openRep = async (r: RepSummary) => {
    setActive(r);
    setCalls(null);
    const res = await fetch(`/api/quality?rep=${r.repId}`).catch(() => null);
    if (res?.ok) setCalls((await res.json()).calls);
  };

  if (error) return <div className="viewsub">Couldn’t load quality data: {error}</div>;
  if (!summary) return <div className="viewsub">Loading…</div>;

  return (
    <>
      <h2 className="viewtitle">Call quality</h2>
      <div className="viewsub">
        Browser calls (Telnyx pilot), last {windowDays} days · loss/jitter measured in the rep’s
        browser · MOS measured on Telnyx’s network (4.5 = perfect)
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        {summary.length === 0 && (
          <div className="viewsub">No measured calls yet — quality data comes from browser-mode calls.</div>
        )}
        {summary.map((r) => {
          const g = grade(r.avgLossPct, r.avgMaxJitterMs);
          return (
            <div
              key={r.repId}
              className="card"
              style={{ minWidth: 240, flex: 1, cursor: "pointer", outline: active?.repId === r.repId ? "2px solid var(--accent)" : "none" }}
              onClick={() => openRep(r)}
              title="Click for the last 50 calls"
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <b style={{ fontSize: 14 }}>{r.rep}</b>
                <span style={{ fontSize: 12, fontWeight: 700, color: g.color }}>{g.label}</span>
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
                <div>
                  <div style={{ fontSize: 19, fontWeight: 800 }}>{r.avgLossPct}%</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)" }}>avg loss</div>
                </div>
                <div>
                  <div style={{ fontSize: 19, fontWeight: 800 }}>{r.avgMaxJitterMs}ms</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)" }}>avg peak jitter</div>
                </div>
                <div>
                  <div style={{ fontSize: 19, fontWeight: 800 }}>{r.avgMos ?? "—"}</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)" }}>avg MOS</div>
                </div>
                <div>
                  <div style={{ fontSize: 19, fontWeight: 800 }}>{r.calls}</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)" }}>calls</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {active && (
        <div className="card">
          <div className="panel-h">{active.rep} — last 50 measured calls</div>
          {!calls && <div style={{ fontSize: 13, color: "var(--text-3)" }}>Loading…</div>}
          {calls?.map((c, i) => {
            const g = grade(c.avgLossPct ?? 0, c.maxJitterMs ?? 0);
            return (
              <div className="stmt-row" key={i} style={{ alignItems: "center" }}>
                <div style={{ fontSize: 12.5 }}>
                  {fmtWhen(c.at)}
                  <span style={{ color: "var(--text-3)" }}>
                    {" "}· {c.durationS ? `${Math.floor(c.durationS / 60)}m ${c.durationS % 60}s` : "—"}
                    {c.disposition ? ` · ${c.disposition.replace("_", " ")}` : ""}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, fontVariantNumeric: "tabular-nums", display: "flex", gap: 12, alignItems: "center" }}>
                  <span>{c.avgLossPct ?? 0}% loss</span>
                  <span>{c.maxJitterMs ?? 0}ms jitter</span>
                  <span>{c.mos ? `MOS ${c.mos}` : ""}</span>
                  <span style={{ color: g.color, fontWeight: 700 }}>{g.label}</span>
                </div>
              </div>
            );
          })}
          {calls?.length === 0 && <div style={{ fontSize: 13, color: "var(--text-3)" }}>No measured calls.</div>}
        </div>
      )}
    </>
  );
}
