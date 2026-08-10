"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Admin-only engagement dashboard: per-rep daily time split into
 * dialing / talking / between-calls / other / idle, engaged total vs the
 * 4-hour KPI, and a 7-day engaged trend. Data = call_events (authoritative
 * talk/dial) + client activity intervals; idle is the uncovered gap.
 */

interface RepRow {
  repId: string;
  name: string;
  email: string;
  dialingS: number;
  talkingS: number;
  inboundTalkS: number;
  betweenS: number;
  otherS: number;
  idleS: number;
  engagedS: number;
  firstAt: string | null;
  lastAt: string | null;
  dials: number;
  connects: number;
}

const COLORS = {
  talking: "#4cc44c",
  dialing: "#d95b31",
  between: "#4a94ec",
  other: "#9c9285",
  idle: "rgba(150,140,125,0.25)",
};

function hm(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}

function fmtClock(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit",
  });
}

function shiftDate(date: string, days: number): string {
  return new Date(new Date(`${date}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export function EngagementView() {
  const [date, setDate] = useState<string>(() =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
  );
  const [data, setData] = useState<{ kpiHours: number; reps: RepRow[]; trend: { date: string; byRep: Record<string, number> }[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/admin/engagement?date=${d}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const kpiS = (data?.kpiHours ?? 4) * 3600;

  return (
    <div>
      <div className="viewhead">
        <h1>⏱ Engagement</h1>
      </div>
      <p className="viewsub">
        Time engaged in calling per rep — talk & dial time from call records, between-call time from live
        activity, idle = uncovered gaps. KPI: {data?.kpiHours ?? 4}h/day engaged. "Other work" (CRM/admin
        pages) is tracked but doesn't count.
      </p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 18 }}>
        <button className="btn ghost" onClick={() => setDate(shiftDate(date, -1))}>‹</button>
        <b style={{ fontSize: 15, minWidth: 130, textAlign: "center" }}>
          {new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
        </b>
        <button className="btn ghost" onClick={() => setDate(shiftDate(date, 1))} disabled={date >= today}>›</button>
        {date !== today && (
          <button className="btn ghost" style={{ fontSize: 13 }} onClick={() => setDate(today)}>Today</button>
        )}
      </div>

      {error && <p className="viewsub" style={{ color: "var(--crit)" }}>{error}</p>}
      {loading && !data && <p className="viewsub">Loading…</p>}

      {data?.reps.map((r) => {
        const stack: { key: keyof typeof COLORS; label: string; s: number }[] = [
          { key: "talking", label: "Talking", s: r.talkingS },
          { key: "dialing", label: "Dialing", s: r.dialingS },
          { key: "between", label: "Between calls", s: r.betweenS },
          { key: "other", label: "Other work", s: r.otherS },
          { key: "idle", label: "Idle", s: r.idleS },
        ];
        const total = stack.reduce((a, x) => a + x.s, 0);
        const pct = Math.min(r.engagedS / kpiS, 1);
        const met = r.engagedS >= kpiS;
        return (
          <div key={r.repId} className="card" style={{ marginBottom: 14, padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
              <b style={{ fontSize: 16 }}>{r.name}</b>
              <span style={{ fontSize: 20, fontWeight: 800, color: met ? "var(--good)" : "var(--text-1)" }}>
                {hm(r.engagedS)}
              </span>
              <span style={{ fontSize: 13, color: "var(--text-3)" }}>
                engaged {met ? "✓ goal met" : `of ${data.kpiHours}h goal`}
              </span>
              <span style={{ fontSize: 12.5, color: "var(--text-3)", marginLeft: "auto" }}>
                {r.dials} dials · {r.connects} connects · {fmtClock(r.firstAt)}–{fmtClock(r.lastAt)}
                {r.inboundTalkS > 60 ? ` · ${hm(r.inboundTalkS)} inbound talk` : ""}
              </span>
            </div>

            {/* KPI progress */}
            <div style={{ height: 6, borderRadius: 4, background: "var(--surface-2)", marginBottom: 12, overflow: "hidden" }}>
              <div style={{ width: `${pct * 100}%`, height: "100%", borderRadius: 4, background: met ? "var(--good)" : "var(--accent)" }} />
            </div>

            {/* Day composition */}
            {total > 0 ? (
              <>
                <div style={{ display: "flex", height: 26, borderRadius: 7, overflow: "hidden", border: "1px solid var(--border-soft)" }}>
                  {stack.filter((x) => x.s > 0).map((x) => (
                    <div
                      key={x.key}
                      title={`${x.label}: ${hm(x.s)}`}
                      style={{ width: `${(x.s / total) * 100}%`, background: COLORS[x.key], minWidth: x.s > 0 ? 2 : 0 }}
                    />
                  ))}
                </div>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8, fontSize: 12.5, color: "var(--text-2)" }}>
                  {stack.map((x) => (
                    <span key={x.key}>
                      <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: COLORS[x.key], marginRight: 5, verticalAlign: -1 }} />
                      {x.label} <b>{hm(x.s)}</b>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="viewsub" style={{ margin: 0 }}>No activity recorded.</p>
            )}

            {/* 7-day engaged trend */}
            {data.trend.length > 0 && (
              <div style={{ display: "flex", gap: 6, alignItems: "flex-end", marginTop: 14, height: 46 }}>
                {data.trend.map((t) => {
                  const s = t.byRep[r.email] ?? 0;
                  const h = Math.max(3, Math.min(40, (s / kpiS) * 40));
                  return (
                    <div key={t.date} title={`${t.date}: ${hm(s)} engaged`} style={{ textAlign: "center" }}>
                      <div style={{ width: 26, height: h, borderRadius: 4, background: s >= kpiS ? "var(--good)" : "var(--accent-2)", opacity: t.date === date ? 1 : 0.55 }} />
                      <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 3 }}>
                        {new Date(`${t.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "narrow" })}
                      </div>
                    </div>
                  );
                })}
                <span style={{ fontSize: 11.5, color: "var(--text-3)", marginLeft: 6 }}>7-day engaged</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
