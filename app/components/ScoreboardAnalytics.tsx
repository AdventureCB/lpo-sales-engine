"use client";

import { useEffect, useState } from "react";

/**
 * Scoreboard analytics: dials↔talk scatter (one dot per rep-day), weekly SMS
 * response-rate lines, and lifetime talk-time leaders. Same fixed rep colors
 * and hover-tooltip pattern as the main scoreboard charts.
 */

interface DialsTalkRow { day: string; rep: string; dials: number; talk_s: number }
interface SmsRateRow { week: string; rep: string; outbound: number; replied: number }
interface LeaderRow { rep: string; peer_phone: string; contact_name: string | null; calls: number; talk_s: number; last_call: string }
interface JourneyTalkRow { rep: string; state: string; depositAt: string | null; confirmedAt: string | null; toDepositS: number; toConfirmS: number }

const SERIES_COLORS: Record<string, string> = {
  parker: "var(--series-parker)",
  jackson: "var(--series-jackson)",
};
const FALLBACK_COLORS = ["#0ca30c", "#fab219", "#8a8a8a"];

const repKey = (name: string) => name.split(" ")[0].toLowerCase();

function fmtTalk(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function pearson(pts: { x: number; y: number }[]): number | null {
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    dx += (p.x - mx) ** 2;
    dy += (p.y - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

type Tip = { x: number; y: number; html: string } | null;

/** Monday-of-week (PT) for weekly bucketing. */
function weekOf(iso: string): string {
  const dateStr = new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

interface TrendPoint { week: string; rep: string; avgS: number; n: number }

/** Weekly-average line chart: one line per rep, minutes on the y axis. */
function TrendChart({
  points,
  repsOrder,
  colorFor,
  onHover,
  label,
}: {
  points: TrendPoint[];
  repsOrder: string[];
  colorFor: (rep: string, i: number) => string;
  onHover: (tip: Tip) => void;
  label: string;
}) {
  const H = 250, W = 480, padL = 44, padB = 32, padT = 10, padR = 12;
  const plotW = W - padL - padR, plotH = H - padB - padT;
  const weeks = [...new Set(points.map((p) => p.week))].sort();
  const yMax = Math.max(10, Math.ceil(Math.max(...points.map((p) => p.avgS / 60), 0) / 10) * 10);
  const wx = (i: number) => padL + (weeks.length < 2 ? plotW / 2 : (i / (weeks.length - 1)) * plotW);
  const y = (s: number) => padT + plotH - (s / 60 / yMax) * plotH;

  if (points.length === 0) {
    return <div style={{ fontSize: 13, color: "var(--text-3)", padding: "24px 0" }}>No data yet.</div>;
  }
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {[0, 1, 2].map((g) => {
        const gy = padT + plotH - (plotH * g) / 2;
        return (
          <g key={g}>
            <line x1={padL} x2={W - padR} y1={gy} y2={gy} stroke={g === 0 ? "#3a3530" : "#2b2724"} strokeWidth={1} />
            <text x={padL - 8} y={gy + 4} textAnchor="end" fontSize={10.5} fill="#7d766c">
              {Math.round((yMax * g) / 2)}m
            </text>
          </g>
        );
      })}
      {weeks.map((w, i) => (
        <text key={w} x={wx(i)} y={H - 8} textAnchor="middle" fontSize={10.5} fill="#7d766c">
          {fmtDay(w)}
        </text>
      ))}
      {repsOrder.map((rep, ri) => {
        const pts = weeks
          .map((w, i) => ({ i, p: points.find((x) => x.week === w && x.rep === rep) }))
          .filter((x): x is { i: number; p: TrendPoint } => Boolean(x.p));
        const path = pts.map((x, j) => `${j === 0 ? "M" : "L"}${wx(x.i)},${y(x.p.avgS)}`).join(" ");
        return (
          <g key={rep}>
            {pts.length > 1 && <path d={path} fill="none" stroke={colorFor(rep, ri)} strokeWidth={2} />}
            {pts.map((x) => (
              <circle
                key={x.i}
                cx={wx(x.i)}
                cy={y(x.p.avgS)}
                r={4.5}
                fill={colorFor(rep, ri)}
                stroke="var(--surface-1)"
                strokeWidth={2}
                onMouseMove={(e) =>
                  onHover({
                    x: e.clientX,
                    y: e.clientY,
                    html: `${rep.split(" ")[0]} · wk of ${fmtDay(x.p.week)}<br><b>${fmtTalk(Math.round(x.p.avgS))}</b> avg ${label} · ${x.p.n} ${x.p.n === 1 ? "journey" : "journeys"}`,
                  })
                }
                onMouseLeave={() => onHover(null)}
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

/** (rep, week) → average of a per-journey talk metric. */
function weeklyAverages(
  rows: JourneyTalkRow[],
  dateOf: (r: JourneyTalkRow) => string | null,
  valueOf: (r: JourneyTalkRow) => number
): TrendPoint[] {
  const acc = new Map<string, { rep: string; week: string; sum: number; n: number }>();
  for (const r of rows) {
    const date = dateOf(r);
    const v = valueOf(r);
    if (!date || v <= 0) continue;
    const week = weekOf(date);
    const key = `${r.rep}|${week}`;
    const a = acc.get(key) ?? { rep: r.rep, week, sum: 0, n: 0 };
    a.sum += v;
    a.n++;
    acc.set(key, a);
  }
  return [...acc.values()].map((a) => ({ week: a.week, rep: a.rep, avgS: a.sum / a.n, n: a.n }));
}

export function ScoreboardAnalytics({ onHover }: { onHover: (tip: Tip) => void }) {
  const [data, setData] = useState<{ dialsTalk: DialsTalkRow[]; smsRate: SmsRateRow[]; leaders: LeaderRow[]; journeyTalk: JourneyTalkRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/scoreboard/analytics")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="viewsub">Couldn’t load analytics: {error}</div>;
  if (!data) return <div className="viewsub">Loading analytics…</div>;

  const reps = [...new Set(data.dialsTalk.map((r) => r.rep))];
  const colorFor = (rep: string, i: number) => SERIES_COLORS[repKey(rep)] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];

  // ── Scatter: dials vs talk minutes, one point per rep-day ────────────────
  const H = 250, W = 480, padL = 44, padB = 32, padT = 10, padR = 12;
  const plotW = W - padL - padR, plotH = H - padB - padT;
  const points = data.dialsTalk
    .filter((r) => r.dials > 0 || r.talk_s > 0)
    .map((r) => ({ ...r, x: r.dials, y: r.talk_s / 60 }));
  const xMax = Math.max(10, Math.ceil(Math.max(...points.map((p) => p.x), 0) / 10) * 10);
  const yMax = Math.max(10, Math.ceil(Math.max(...points.map((p) => p.y), 0) / 10) * 10);
  const sx = (v: number) => padL + (v / xMax) * plotW;
  const sy = (v: number) => padT + plotH - (v / yMax) * plotH;
  const rByRep = reps
    .map((rep) => {
      const r = pearson(points.filter((p) => p.rep === rep).map((p) => ({ x: p.x, y: p.y })));
      return r == null ? null : `${rep.split(" ")[0]} r = ${r.toFixed(2)}`;
    })
    .filter(Boolean)
    .join(" · ");

  // ── SMS response rate: weekly % per rep ──────────────────────────────────
  const weeks = [...new Set(data.smsRate.map((r) => r.week))].sort();
  const smsReps = [...new Set(data.smsRate.map((r) => r.rep))];
  const wx = (i: number) => padL + (weeks.length < 2 ? plotW / 2 : (i / (weeks.length - 1)) * plotW);
  const ry = (pct: number) => padT + plotH - (pct / 100) * plotH;

  const leadersByRep = new Map<string, LeaderRow[]>();
  for (const l of data.leaders) {
    leadersByRep.set(l.rep, [...(leadersByRep.get(l.rep) ?? []), l]);
  }

  // Talk investment per sale: per-rep lifetime averages + weekly trends.
  const jt = data.journeyTalk ?? [];
  const talkReps = [...new Set(jt.map((r) => r.rep))].sort((a, b) => {
    const ia = reps.indexOf(a), ib = reps.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const repAvg = (rep: string, pick: (r: JourneyTalkRow) => number) => {
    const vals = jt.filter((r) => r.rep === rep).map(pick).filter((v) => v > 0);
    return vals.length ? { avgS: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length } : null;
  };
  const depTrend = weeklyAverages(jt, (r) => r.depositAt, (r) => r.toDepositS);
  const confTrend = weeklyAverages(
    jt.filter((r) => r.confirmedAt),
    (r) => r.confirmedAt,
    (r) => r.toConfirmS
  );

  return (
    <>
      <div className="charts" style={{ marginTop: 18 }}>
        <div className="card chart-card">
          <h3>Dials vs talk time</h3>
          <div className="sub">
            Each dot is one rep-day (last 60 days){rByRep ? ` · ${rByRep}` : ""}
          </div>
          <div className="legend">
            {reps.map((rep, i) => (
              <span key={rep}>
                <span className="sw" style={{ background: colorFor(rep, i) }} />
                {rep.split(" ")[0]}
              </span>
            ))}
          </div>
          <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
            {[0, 1, 2].map((g) => {
              const y = padT + plotH - (plotH * g) / 2;
              return (
                <g key={g}>
                  <line x1={padL} x2={W - padR} y1={y} y2={y} stroke={g === 0 ? "#3a3530" : "#2b2724"} strokeWidth={1} />
                  <text x={padL - 8} y={y + 4} textAnchor="end" fontSize={10.5} fill="#7d766c">
                    {Math.round((yMax * g) / 2)}m
                  </text>
                </g>
              );
            })}
            {[0, 1, 2].map((g) => {
              const x = padL + (plotW * g) / 2;
              return (
                <text key={g} x={x} y={H - 8} textAnchor="middle" fontSize={10.5} fill="#7d766c">
                  {Math.round((xMax * g) / 2)} dials
                </text>
              );
            })}
            {points.map((p, i) => (
              <circle
                key={i}
                cx={sx(p.x)}
                cy={sy(p.y)}
                r={4.5}
                fill={colorFor(p.rep, reps.indexOf(p.rep))}
                stroke="var(--surface-1)"
                strokeWidth={2}
                onMouseMove={(e) =>
                  onHover({
                    x: e.clientX,
                    y: e.clientY,
                    html: `${p.rep.split(" ")[0]} · ${fmtDay(p.day)}<br><b>${p.dials}</b> dials · <b>${fmtTalk(p.talk_s)}</b> talk`,
                  })
                }
                onMouseLeave={() => onHover(null)}
              />
            ))}
          </svg>
        </div>

        <div className="card chart-card">
          <h3>Text response rate</h3>
          <div className="sub">% of outbound texts answered within 48h, by week</div>
          {weeks.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text-3)", padding: "24px 0" }}>
              Tracking starts now — texts sent from today on are paired with replies.
            </div>
          ) : (
            <>
              <div className="legend">
                {smsReps.map((rep, i) => (
                  <span key={rep}>
                    <span className="sw" style={{ background: colorFor(rep, i) }} />
                    {rep.split(" ")[0]}
                  </span>
                ))}
              </div>
              <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
                {[0, 1, 2].map((g) => {
                  const y = padT + plotH - (plotH * g) / 2;
                  return (
                    <g key={g}>
                      <line x1={padL} x2={W - padR} y1={y} y2={y} stroke={g === 0 ? "#3a3530" : "#2b2724"} strokeWidth={1} />
                      <text x={padL - 8} y={y + 4} textAnchor="end" fontSize={10.5} fill="#7d766c">
                        {g * 50}%
                      </text>
                    </g>
                  );
                })}
                {weeks.map((w, i) => (
                  <text key={w} x={wx(i)} y={H - 8} textAnchor="middle" fontSize={10.5} fill="#7d766c">
                    {fmtDay(w)}
                  </text>
                ))}
                {smsReps.map((rep, ri) => {
                  const rows = weeks.map((w) => data.smsRate.find((r) => r.week === w && r.rep === rep));
                  const pts = rows
                    .map((row, i) => (row && row.outbound > 0 ? { i, row, pct: (100 * row.replied) / row.outbound } : null))
                    .filter(Boolean) as { i: number; row: SmsRateRow; pct: number }[];
                  const path = pts.map((p, j) => `${j === 0 ? "M" : "L"}${wx(p.i)},${ry(p.pct)}`).join(" ");
                  return (
                    <g key={rep}>
                      {pts.length > 1 && <path d={path} fill="none" stroke={colorFor(rep, ri)} strokeWidth={2} />}
                      {pts.map((p) => (
                        <circle
                          key={p.i}
                          cx={wx(p.i)}
                          cy={ry(p.pct)}
                          r={4.5}
                          fill={colorFor(rep, ri)}
                          stroke="var(--surface-1)"
                          strokeWidth={2}
                          onMouseMove={(e) =>
                            onHover({
                              x: e.clientX,
                              y: e.clientY,
                              html: `${rep.split(" ")[0]} · wk of ${fmtDay(p.row.week)}<br><b>${p.row.replied}/${p.row.outbound}</b> replied · <b>${Math.round(p.pct)}%</b>`,
                            })
                          }
                          onMouseLeave={() => onHover(null)}
                        />
                      ))}
                    </g>
                  );
                })}
              </svg>
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h3 style={{ margin: 0 }}>Talk time per sale</h3>
        <div className="sub" style={{ marginBottom: 12 }}>
          Conversation minutes invested per journey — before the $500 deposit, and from deposit to the confirmed build
        </div>
        {jt.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-3)" }}>No journeys with matched calls yet.</div>
        ) : (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
            {talkReps.map((rep, i) => {
              const dep = repAvg(rep, (r) => r.toDepositS);
              const conf = repAvg(rep, (r) => (r.confirmedAt ? r.toConfirmS : 0));
              return (
                <div key={rep} style={{ background: "var(--surface-2)", borderRadius: 9, padding: "10px 14px", minWidth: 220, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                    <span className="sw" style={{ background: colorFor(rep, reps.indexOf(rep) === -1 ? i : reps.indexOf(rep)) }} />
                    <b style={{ fontSize: 13 }}>{rep.split(" ")[0]}</b>
                  </div>
                  <div style={{ display: "flex", gap: 18 }}>
                    <div>
                      <div style={{ fontSize: 19, fontWeight: 800 }}>{dep ? fmtTalk(Math.round(dep.avgS)) : "—"}</div>
                      <div style={{ fontSize: 11, color: "var(--text-3)" }}>avg → deposit{dep ? ` (${dep.n})` : ""}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 19, fontWeight: 800 }}>{conf ? fmtTalk(Math.round(conf.avgS)) : "—"}</div>
                      <div style={{ fontSize: 11, color: "var(--text-3)" }}>avg → confirmation{conf ? ` (${conf.n})` : ""}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {jt.length > 0 && (
        <div className="charts" style={{ marginTop: 18 }}>
          <div className="card chart-card">
            <h3>Talk → deposit over time</h3>
            <div className="sub">Weekly average conversation time before the deposit, by deposit week</div>
            <div className="legend">
              {talkReps.map((rep, i) => (
                <span key={rep}>
                  <span className="sw" style={{ background: colorFor(rep, reps.indexOf(rep) === -1 ? i : reps.indexOf(rep)) }} />
                  {rep.split(" ")[0]}
                </span>
              ))}
            </div>
            <TrendChart
              points={depTrend}
              repsOrder={talkReps}
              colorFor={(rep, i) => colorFor(rep, reps.indexOf(rep) === -1 ? i : reps.indexOf(rep))}
              onHover={onHover}
              label="talk → deposit"
            />
          </div>
          <div className="card chart-card">
            <h3>Talk → confirmation over time</h3>
            <div className="sub">Weekly average from deposit to confirmed build, by confirmation week</div>
            <div className="legend">
              {talkReps.map((rep, i) => (
                <span key={rep}>
                  <span className="sw" style={{ background: colorFor(rep, reps.indexOf(rep) === -1 ? i : reps.indexOf(rep)) }} />
                  {rep.split(" ")[0]}
                </span>
              ))}
            </div>
            <TrendChart
              points={confTrend}
              repsOrder={talkReps}
              colorFor={(rep, i) => colorFor(rep, reps.indexOf(rep) === -1 ? i : reps.indexOf(rep))}
              onHover={onHover}
              label="talk → confirmation"
            />
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <h3 style={{ margin: 0 }}>15+ minute contacts</h3>
        <div className="sub" style={{ marginBottom: 10 }}>
          Contacts with over 15 minutes of lifetime conversation time · attributed to the rep with the most talk time
        </div>
        {data.leaders.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--text-3)" }}>No contacts over 15 minutes yet.</div>
        )}
        {[...leadersByRep.entries()].map(([rep, rows]) => (
          <div key={rep} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-3)", margin: "8px 0 4px" }}>
              {rep} · {rows.length}
            </div>
            {rows.map((l) => (
              <div className="stmt-row" key={l.peer_phone}>
                <div style={{ minWidth: 0 }}>
                  <b style={{ fontSize: 13.5 }}>{l.contact_name?.trim() || l.peer_phone}</b>
                  {l.contact_name && (
                    <span style={{ fontSize: 12, color: "var(--text-3)", marginLeft: 8, fontVariantNumeric: "tabular-nums" }}>
                      {l.peer_phone}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--text-2)", flexShrink: 0, marginLeft: 10, fontVariantNumeric: "tabular-nums" }}>
                  <b style={{ color: "var(--text-1)" }}>{fmtTalk(l.talk_s)}</b> · {l.calls} call{l.calls === 1 ? "" : "s"} · last{" "}
                  {new Date(l.last_call).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
