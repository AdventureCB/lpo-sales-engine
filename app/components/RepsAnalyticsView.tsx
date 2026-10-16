"use client";

import { useEffect, useState } from "react";

interface Cohort { month: string; worked: number; confirmed: number; presumed: number; maturing: boolean }
interface Rep {
  email: string; name: string;
  book: { open: number; onPlan: number; planned: number; touchedInWindow: number; attempted: number; contacted: number; staleness: Record<string, number> };
  throughput: { workDays: number; touches: number; distinctDeals: number; touchesPerDay: number; dealsPerDay: number; impliedCapacity: number };
  conversion: { workedAll: number; confirmedAll: number; presumedAll: number; workedMatured: number; confirmedMatured: number; presumedMatured: number; cohorts: Cohort[] };
  reprospect: { claimed: number; attemptedInHold: number; takenOver: number };
}

const pct = (n: number, d: number, digits = 0) => (d > 0 ? `${((100 * n) / d).toFixed(digits)}%` : "—");
const BUCKETS = ["0-7", "8-14", "15-30", "31-60", "60+", "never"];
const BUCKET_COLOR: Record<string, string> = { "0-7": "#3a9d5d", "8-14": "#7fb069", "15-30": "#d9a62b", "31-60": "#e07b39", "60+": "#c0392b", never: "#6c757d" };

export function RepsAnalyticsView() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<{ days: number; reps: Rep[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setData(null); setErr(null);
    fetch(`/api/admin/analytics/reps?days=${days}`).then((r) => r.json()).then((d) => (d.error ? setErr(d.error) : setData(d))).catch(() => setErr("failed to load"));
  }, [days]);

  const th: React.CSSProperties = { padding: "6px 8px", fontSize: 12, color: "var(--text-3)", textAlign: "right", whiteSpace: "nowrap", verticalAlign: "bottom" };
  const td: React.CSSProperties = { padding: "7px 8px", fontSize: 13, textAlign: "right", borderTop: "1px solid var(--border-soft)", fontVariantNumeric: "tabular-nums" };
  const left: React.CSSProperties = { textAlign: "left" };
  const grp: React.CSSProperties = { ...th, textAlign: "center", borderBottom: "1px solid var(--border-soft)", color: "var(--text-2)", fontWeight: 700 };

  return (
    <>
      <h2 style={{ margin: "0 0 4px" }}>👤 Reps</h2>
      <p className="viewsub" style={{ marginTop: 0 }}>
        Two questions per rep: do the leads they work turn into customers, and how much of their book do they actually keep alive. Click a row for cohorts and staleness.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "10px 0 14px" }}>
        <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>Activity window</span>
        {[7, 14, 30, 90].map((d) => <button key={d} className={`btn ${days === d ? "primary" : "ghost"}`} style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => setDays(d)}>{d}d</button>)}
      </div>
      {err && <div style={{ color: "var(--bad)" }}>{err}</div>}
      {!data && !err && <div className="viewsub">Computing…</div>}
      {data && (
        <>
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ ...th, ...left }} />
                  <th style={grp} colSpan={4}>Conversion (matured cohorts)</th>
                  <th style={grp} colSpan={5}>Open book · last {data.days}d</th>
                  <th style={grp} colSpan={3}>Throughput</th>
                  <th style={grp} colSpan={3}>Reprospect</th>
                </tr>
                <tr>
                  <th style={{ ...th, ...left }}>Rep</th>
                  <th style={th} title="Deals the rep made a real outbound touch on, first touched 60+ days ago">Worked</th>
                  <th style={th} title="Won, credited to the owner at close">Confirmed</th>
                  <th style={th} title="Confirmed + Deposit Placed">Presumed</th>
                  <th style={th}>Conv. / presumed</th>
                  <th style={th}>Open</th>
                  <th style={th} title="Touched in the window OR has a future scheduled activity">On plan</th>
                  <th style={th} title="Open deals ever attempted (any rep)">Attempted</th>
                  <th style={th} title="Open deals that ever had a conversation">Contacted</th>
                  <th style={{ ...th, ...left }} title="Open deals with NO future plan, by days since the rep's last touch">Staleness (no plan)</th>
                  <th style={th} title="Days with tracked activity in the window">Work days</th>
                  <th style={th} title="Distinct deals touched per working day">Deals / day</th>
                  <th style={th} title="Deals per day × 21 — the book size this pace covers at a monthly cadence">Implied capacity</th>
                  <th style={th}>Claimed</th>
                  <th style={th} title="Claimed pool deals the rep actually dialed during the hold">Attempted</th>
                  <th style={th} title="Claimed pool deals that became the rep's (scheduled something)">Taken over</th>
                </tr>
              </thead>
              <tbody>
                {data.reps.map((r) => {
                  const b = r.book, c = r.conversion, t = r.throughput, p = r.reprospect;
                  const noPlan = BUCKETS.reduce((n, k) => n + (b.staleness[k] ?? 0), 0);
                  const over = b.open > t.impliedCapacity && t.impliedCapacity > 0;
                  return (
                    <>
                      <tr key={r.email} style={{ cursor: "pointer", background: open === r.email ? "var(--surface-2)" : undefined }} onClick={() => setOpen(open === r.email ? null : r.email)}>
                        <td style={{ ...td, ...left, fontWeight: 700 }}>{open === r.email ? "▾" : "▸"} {r.name}</td>
                        <td style={td}>{c.workedMatured.toLocaleString()}</td>
                        <td style={td}>{c.confirmedMatured}</td>
                        <td style={td}>{c.presumedMatured}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{pct(c.confirmedMatured, c.workedMatured, 1)} <span style={{ color: "var(--text-3)", fontWeight: 400 }}>/ {pct(c.presumedMatured, c.workedMatured, 1)}</span></td>
                        <td style={td}>{b.open.toLocaleString()}</td>
                        <td style={{ ...td, fontWeight: 700, color: b.open && b.onPlan / b.open < 0.5 ? "var(--warn)" : undefined }}>{pct(b.onPlan, b.open)}</td>
                        <td style={td}>{pct(b.attempted, b.open)}</td>
                        <td style={td}>{pct(b.contacted, b.open)}</td>
                        <td style={{ ...td, ...left, minWidth: 180 }}>
                          <div style={{ display: "flex", height: 12, borderRadius: 4, overflow: "hidden", background: "var(--surface-3)" }} title={BUCKETS.map((k) => `${k}: ${b.staleness[k] ?? 0}`).join(" · ")}>
                            {BUCKETS.map((k) => (b.staleness[k] ?? 0) > 0 && <div key={k} style={{ width: `${(100 * (b.staleness[k] ?? 0)) / Math.max(noPlan, 1)}%`, background: BUCKET_COLOR[k] }} />)}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>{noPlan.toLocaleString()} unplanned · {(b.staleness["60+"] ?? 0) + (b.staleness.never ?? 0)} cold</div>
                        </td>
                        <td style={td}>{t.workDays}</td>
                        <td style={td}>{t.dealsPerDay}</td>
                        <td style={{ ...td, fontWeight: 700, color: over ? "var(--warn)" : undefined }} title={over ? `Book is ${b.open - t.impliedCapacity} deals over what this pace covers monthly` : undefined}>{t.impliedCapacity.toLocaleString()}</td>
                        <td style={td}>{p.claimed}</td>
                        <td style={td}>{p.claimed ? `${p.attemptedInHold} (${pct(p.attemptedInHold, p.claimed)})` : "—"}</td>
                        <td style={td}>{p.takenOver}</td>
                      </tr>
                      {open === r.email && (
                        <tr key={`${r.email}-x`}>
                          <td colSpan={16} style={{ padding: "10px 14px 16px", borderTop: "1px solid var(--border-soft)", background: "var(--surface-2)" }}>
                            <div style={{ display: "grid", gridTemplateColumns: "minmax(420px, 1fr) minmax(280px, 0.6fr)", gap: 18 }}>
                              <div>
                                <div className="panel-h" style={{ marginTop: 0 }}>Conversion by first-touch month</div>
                                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                                  <thead><tr><th style={{ ...th, ...left }}>Cohort</th><th style={th}>Worked</th><th style={th}>Confirmed</th><th style={th}>Presumed</th><th style={th}>Conv.</th><th style={th}>Presumed</th></tr></thead>
                                  <tbody>
                                    {c.cohorts.map((k) => (
                                      <tr key={k.month} style={{ opacity: k.maturing ? 0.6 : 1 }}>
                                        <td style={{ ...td, ...left }}>{k.month}{k.maturing && <span style={{ fontSize: 11, color: "var(--text-3)", marginLeft: 6 }}>maturing</span>}</td>
                                        <td style={td}>{k.worked}</td><td style={td}>{k.confirmed}</td><td style={td}>{k.presumed}</td>
                                        <td style={{ ...td, fontWeight: 700 }}>{pct(k.confirmed, k.worked, 1)}</td><td style={td}>{pct(k.presumed, k.worked, 1)}</td>
                                      </tr>
                                    ))}
                                    <tr style={{ fontWeight: 700 }}><td style={{ ...td, ...left }}>All time</td><td style={td}>{c.workedAll}</td><td style={td}>{c.confirmedAll}</td><td style={td}>{c.presumedAll}</td><td style={td}>{pct(c.confirmedAll, c.workedAll, 1)}</td><td style={td}>{pct(c.presumedAll, c.workedAll, 1)}</td></tr>
                                  </tbody>
                                </table>
                              </div>
                              <div>
                                <div className="panel-h" style={{ marginTop: 0 }}>Open book without a plan — days since last touch</div>
                                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                                  <tbody>
                                    {BUCKETS.map((k) => (
                                      <tr key={k}><td style={{ ...td, ...left }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: BUCKET_COLOR[k], marginRight: 8 }} />{k === "never" ? "never touched by this rep" : `${k} days`}</td><td style={td}>{b.staleness[k] ?? 0}</td><td style={{ ...td, color: "var(--text-3)" }}>{pct(b.staleness[k] ?? 0, noPlan)}</td></tr>
                                    ))}
                                    <tr><td style={{ ...td, ...left, color: "var(--text-2)" }}>with a future activity scheduled</td><td style={td}>{b.planned}</td><td style={td} /></tr>
                                  </tbody>
                                </table>
                                <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>
                                  {t.touches.toLocaleString()} touches on {t.distinctDeals.toLocaleString()} deals over {t.workDays} working days ({t.touchesPerDay}/day).
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="viewsub" style={{ marginTop: 10, fontSize: 12.5 }}>
            <b>Worked</b> = the rep made at least one real outbound touch (dial, answered call, email, text; automation excluded). <b>Confirmed</b> = won, credited to the owner at close. <b>Presumed</b> adds deals in a Deposit Placed stage.
            Conversion is shown on <b>matured cohorts</b> (first touched 60+ days ago) so recent leads don't read as failures; the drill-in shows every month.
            <b> On plan</b> = touched in the window or carrying a future scheduled activity, so a 6-month "call me next year" task counts as managed. <b>Implied capacity</b> = distinct deals touched per working day × 21, i.e. the book size this pace covers once a month.
          </div>
        </>
      )}
    </>
  );
}
