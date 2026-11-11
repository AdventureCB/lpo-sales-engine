"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Step { i: number; step: string; label: string; reached: number; dropped: number; backs: number; changes: number; avgMs: number | null; medianMs: number | null; p75Ms: number | null; timed: number }
interface Report {
  start: string; end: string;
  headline: { started: number; saw3d: number; reachedForm: number; submitted: number; quotes: number; medianCompleteMs: number | null; active: number };
  funnel: Step[];
  answers: Record<string, { answer: string; n: number; total: number }[]>;
  engagement: { more: { product: string | null; runs: number }[]; runsWithMore: number; runsWithSound: number };
  viewer: { reveals: number; medianWaitMs: number | null; p90WaitMs: number | null; topOpen: number; blocked: number; reached4: number };
  gate: { invalid: number; invalidRuns: number; fields: { field: string; n: number }[]; fails: { err: string; n: number }[] };
  versions: string[]; sources: string[];
  abandonedKnown: { runId: string; lastAt: string; furthestStep: string | null; furthestIndex: number | null; contactId: string | null; name: string | null; email: string | null; dealId: string | null }[];
  recent: { runId: string; startedAt: string; device: string | null; furthestStep: string | null; furthestIndex: number | null; submitted: boolean; activeMs: number | null; source: string | null; test: boolean }[];
}
interface RunDetail {
  run: any;
  events: { at: string; name: string; step: string | null; step_index: number | null; ms: number | null; answer: string | null; data: Record<string, unknown> | null }[];
  deal: { id: string; title: string } | null;
}

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((100 * n) / d)}%` : "—");
const secs = (ms: number | null | undefined) => (ms == null ? "—" : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const QUESTION_STEPS = ["make", "model", "bed", "color", "arrive", "weekday", "never", "windows", "climate", "power", "lighting", "water", "gear"];

const th: React.CSSProperties = { textAlign: "left", fontSize: 12, color: "var(--text-3)", fontWeight: 600, padding: "6px 8px", borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid var(--border-soft)", fontSize: 13, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card" style={{ padding: "12px 14px", minWidth: 150, flex: "1 1 150px" }}>
      <div style={{ fontSize: 12, color: "var(--text-3)" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 750, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--text-3)" }}>{sub}</div>}
    </div>
  );
}

export function SurveyAnalyticsView() {
  const [days, setDays] = useState(30);
  const [device, setDevice] = useState("");
  const [version, setVersion] = useState("");
  const [truck, setTruck] = useState("");
  const [source, setSource] = useState("");
  const [test, setTest] = useState(false);
  const [data, setData] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);

  useEffect(() => {
    const q = new URLSearchParams({ days: String(days) });
    if (device) q.set("device", device);
    if (version) q.set("version", version);
    if (truck) q.set("truck", truck);
    if (source) q.set("source", source);
    if (test) q.set("test", "1");
    setLoading(true);
    fetch(`/api/admin/analytics/survey?${q}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) setErr(d.error); else { setData(d); setErr(null); } })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [days, device, version, truck, source, test]);

  // Deep link from a deal: /analytics/survey?run=<run_id>
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get("run");
    if (r) setOpenRun(r);
  }, []);

  useEffect(() => {
    if (!openRun) { setRun(null); return; }
    fetch(`/api/admin/analytics/survey?run=${encodeURIComponent(openRun)}`).then((r) => r.json()).then(setRun).catch(() => setRun(null));
  }, [openRun]);

  const h = data?.headline;
  const funnel = data?.funnel ?? [];
  const started = h?.started ?? 0;
  // Biggest drop = the step that loses the largest share of the runs reaching it.
  const biggest = funnel.reduce<Step | null>((b, s) => (s.reached > 0 && (!b || s.dropped / s.reached > b.dropped / Math.max(1, b.reached)) && s.dropped > 0 ? s : b), null);
  const maxReached = Math.max(1, ...funnel.map((s) => s.reached), started);

  return (
    <>
      <h2 className="viewtitle">Build Survey</h2>
      <div className="viewsub">
        The camper-build survey on <code>/pages/build-your-camper</code>: who starts it, where they leave, and how long each step takes (active time — only while the tab is visible).
        Test traffic is excluded unless you switch it on. A run counts as dropped once it has been quiet 30 minutes.
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "6px 0 14px" }}>
        <select className="vmsel" style={{ width: "auto" }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 14, 30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
        <select className="vmsel" style={{ width: "auto" }} value={device} onChange={(e) => setDevice(e.target.value)}>
          <option value="">All devices</option><option value="mobile">Mobile</option><option value="desktop">Desktop</option>
        </select>
        <select className="vmsel" style={{ width: "auto" }} value={truck} onChange={(e) => setTruck(e.target.value)}>
          <option value="">Any truck path</option><option value="truck">Has a truck</option><option value="no_truck">No truck yet</option>
        </select>
        <select className="vmsel" style={{ width: "auto" }} value={version} onChange={(e) => setVersion(e.target.value)}>
          <option value="">All versions</option>
          {(data?.versions ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="vmsel" style={{ width: "auto" }} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>
          {(data?.sources ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <label style={{ fontSize: 13, display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={test} onChange={(e) => setTest(e.target.checked)} /> Include test traffic
        </label>
        {loading && <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>Loading…</span>}
      </div>
      {err && <div className="card" style={{ color: "var(--crit)" }}>{err}</div>}

      {h && (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <Tile label="Started" value={started.toLocaleString()} sub={h.active ? `${h.active} in progress now` : undefined} />
            <Tile label="Saw the 3D build" value={pct(h.saw3d, started)} sub={`${h.saw3d} runs`} />
            <Tile label="Reached the form" value={pct(h.reachedForm, started)} sub={`${h.reachedForm} runs`} />
            <Tile label="Completion rate" value={pct(h.submitted, started)} sub={`${h.submitted} submitted`} />
            <Tile label="Form conversion" value={pct(h.submitted, h.reachedForm)} sub="submitted ÷ reached form" />
            <Tile label="Quotes opened" value={String(h.quotes)} sub={pct(h.quotes, h.submitted) + " of submits"} />
            <Tile label="Median time to complete" value={secs(h.medianCompleteMs)} sub="active time" />
          </div>

          {started === 0 && (
            <div className="card" style={{ marginBottom: 14, fontSize: 13.5, color: "var(--text-2)" }}>
              No survey runs recorded in this window yet. Runs appear once visitors load the survey page with the updated attr.js.
            </div>
          )}

          <div className="card" style={{ marginBottom: 14, overflowX: "auto" }}>
            <h4 style={{ margin: "0 0 8px" }}>Funnel</h4>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>#</th><th style={th}>Step</th><th style={{ ...th, width: "28%" }}>Reached</th><th style={th}>Dropped here</th><th style={th}>Drop-off</th>
                  <th style={th}>Avg</th><th style={th}>Median</th><th style={th}>p75</th><th style={th}>Back</th><th style={th}>Change answer</th>
                </tr>
              </thead>
              <tbody>
                {funnel.map((s) => {
                  const big = biggest?.i === s.i;
                  return (
                    <tr key={s.i} style={big ? { background: "var(--accent-soft)" } : undefined}>
                      <td style={td}>{s.i}</td>
                      <td style={{ ...td, whiteSpace: "normal" }}>{s.label} <span style={{ color: "var(--text-3)", fontSize: 11.5 }}>{s.step}</span>{big && <b style={{ color: "var(--crit)", fontSize: 11.5 }}> · biggest drop</b>}</td>
                      <td style={td}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ flex: 1, height: 10, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
                            <div style={{ width: `${(100 * s.reached) / maxReached}%`, height: "100%", background: "var(--accent)", borderRadius: 4 }} />
                          </div>
                          <span style={{ minWidth: 70 }}>{s.reached} <span style={{ color: "var(--text-3)" }}>{pct(s.reached, started)}</span></span>
                        </div>
                      </td>
                      <td style={td}>{s.dropped || "—"}</td>
                      <td style={{ ...td, color: s.reached && s.dropped / s.reached >= 0.15 ? "var(--crit)" : undefined, fontWeight: big ? 700 : 400 }}>{s.reached ? pct(s.dropped, s.reached) : "—"}</td>
                      <td style={td}>{secs(s.avgMs)}</td>
                      <td style={td}>{secs(s.medianMs)}</td>
                      <td style={td}>{secs(s.p75Ms)}</td>
                      <td style={td}>{s.reached ? pct(s.backs, s.reached) : "—"}</td>
                      <td style={td}>{s.reached ? pct(s.changes, s.reached) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 6 }}>
              Reached = got at least this far (the no-truck path skips 2–4 and still counts as passing them). Times are per run on that step, summed over back-and-forth visits, from runs that completed the step, each capped at 10 min.
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, marginBottom: 14 }}>
            <div className="card">
              <h4 style={{ margin: "0 0 8px" }}>3D viewer health</h4>
              <div style={{ fontSize: 13.5, display: "grid", gap: 4 }}>
                <div>Build reveal wait: median <b>{secs(data!.viewer.medianWaitMs)}</b> · p90 <b>{secs(data!.viewer.p90WaitMs)}</b> <span style={{ color: "var(--text-3)" }}>({data!.viewer.reveals} reveals)</span></div>
                <div>Appeared with the roof up: <b>{pct(data!.viewer.topOpen, data!.viewer.reveals)}</b> <span style={{ color: "var(--text-3)" }}>({data!.viewer.topOpen})</span></div>
                <div>Viewer never loaded (15s): <b>{data!.viewer.blocked}</b> <span style={{ color: "var(--text-3)" }}>— {pct(data!.viewer.blocked, data!.viewer.reached4)} of runs reaching step 4</span></div>
              </div>
            </div>
            <div className="card">
              <h4 style={{ margin: "0 0 8px" }}>Contact form health</h4>
              <div style={{ fontSize: 13.5, display: "grid", gap: 4 }}>
                <div>Invalid submits: <b>{data!.gate.invalid}</b> across {data!.gate.invalidRuns} runs <span style={{ color: "var(--text-3)" }}>({(data!.gate.invalid / Math.max(1, h.reachedForm)).toFixed(2)} per run reaching the form)</span></div>
                {data!.gate.fields.length > 0 && <div>Most common bad fields: {data!.gate.fields.slice(0, 5).map((f) => `${f.field} (${f.n})`).join(", ")}</div>}
                <div>Failed submits: <b>{data!.gate.fails.reduce((a, f) => a + f.n, 0)}</b>{data!.gate.fails.length ? ` — ${data!.gate.fails.map((f) => `${f.err} (${f.n})`).join(", ")}` : ""}</div>
              </div>
            </div>
            <div className="card">
              <h4 style={{ margin: "0 0 8px" }}>Engagement</h4>
              <div style={{ fontSize: 13.5, display: "grid", gap: 4 }}>
                <div>Opened at least one product video: <b>{pct(data!.engagement.runsWithMore, started)}</b> <span style={{ color: "var(--text-3)" }}>({data!.engagement.runsWithMore})</span></div>
                <div>Turned the intro sound on: <b>{pct(data!.engagement.runsWithSound, started)}</b></div>
                {data!.engagement.more.length > 0 && (
                  <div style={{ color: "var(--text-2)" }}>By product: {data!.engagement.more.map((m) => `${(m.product ?? "?").replace(/_/g, " ")} (${m.runs})`).join(", ")}</div>
                )}
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <h4 style={{ margin: "0 0 8px" }}>Answers <span style={{ fontWeight: 400, fontSize: 12, color: "var(--text-3)" }}>(each run&apos;s final answer; top 10)</span></h4>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
              {QUESTION_STEPS.filter((st) => data!.answers[st]?.length).map((st) => (
                <div key={st}>
                  <div style={{ fontWeight: 650, fontSize: 13, marginBottom: 4 }}>{funnel.find((f) => f.step === st)?.label ?? st}</div>
                  {data!.answers[st].map((a) => (
                    <div key={a.answer} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, marginBottom: 2 }}>
                      <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.answer}>{a.answer}</div>
                      <div style={{ width: 70, height: 8, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}><div style={{ width: `${(100 * a.n) / Math.max(1, a.total)}%`, height: "100%", background: "var(--accent)" }} /></div>
                      <div style={{ width: 64, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{a.n} · {pct(a.n, a.total)}</div>
                    </div>
                  ))}
                </div>
              ))}
              {QUESTION_STEPS.every((st) => !data!.answers[st]?.length) && <div style={{ fontSize: 13, color: "var(--text-3)" }}>No answers yet.</div>}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14, overflowX: "auto" }}>
            <h4 style={{ margin: "0 0 4px" }}>Abandoned — known contacts</h4>
            <div style={{ fontSize: 12.5, color: "var(--text-3)", marginBottom: 8 }}>Dropped off, but the browser is already linked to a contact (earlier form, checkout or email click). Warm follow-ups; DNC contacts are left out.</div>
            {data!.abandonedKnown.length === 0 ? <div style={{ fontSize: 13, color: "var(--text-3)" }}>None in this window.</div> : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>Contact</th><th style={th}>Got to</th><th style={th}>Last active</th><th style={th}></th></tr></thead>
                <tbody>
                  {data!.abandonedKnown.map((a) => (
                    <tr key={a.runId}>
                      <td style={td}>{a.dealId ? <Link href={`/crm/deal/${a.dealId}`} style={{ color: "var(--accent)" }}>{a.name ?? a.email ?? "Contact"}</Link> : (a.name ?? a.email ?? "Contact")}{a.email && a.name ? <span style={{ color: "var(--text-3)" }}> · {a.email}</span> : null}</td>
                      <td style={td}>{a.furthestIndex ?? "—"} · {funnel.find((f) => f.step === a.furthestStep)?.label ?? a.furthestStep ?? "—"}</td>
                      <td style={td}>{when(a.lastAt)}</td>
                      <td style={td}><button className="btn ghost" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => setOpenRun(a.runId)}>Run</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card" style={{ marginBottom: 14, overflowX: "auto" }}>
            <h4 style={{ margin: "0 0 8px" }}>Recent runs</h4>
            {data!.recent.length === 0 ? <div style={{ fontSize: 13, color: "var(--text-3)" }}>None yet.</div> : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>Started</th><th style={th}>Device</th><th style={th}>Source</th><th style={th}>Got to</th><th style={th}>Active time</th><th style={th}>Result</th></tr></thead>
                <tbody>
                  {data!.recent.map((r) => (
                    <tr key={r.runId} onClick={() => setOpenRun(r.runId)} style={{ cursor: "pointer" }}>
                      <td style={td}>{when(r.startedAt)}{r.test ? <span style={{ color: "var(--text-3)" }}> · test</span> : null}</td>
                      <td style={td}>{r.device ?? "—"}</td>
                      <td style={td}>{r.source ?? "(direct)"}</td>
                      <td style={td}>{r.furthestIndex ?? "—"} · {funnel.find((f) => f.step === r.furthestStep)?.label ?? r.furthestStep ?? "—"}</td>
                      <td style={td}>{secs(r.activeMs)}</td>
                      <td style={{ ...td, color: r.submitted ? "var(--good)" : undefined, fontWeight: r.submitted ? 700 : 400 }}>{r.submitted ? "Submitted" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {openRun && (
        <div onClick={() => setOpenRun(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 200, display: "flex", justifyContent: "flex-end" }}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "min(560px, 100vw)", height: "100%", overflowY: "auto", borderRadius: 0, margin: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <h4 style={{ margin: 0 }}>Survey run</h4>
              <button className="btn ghost" style={{ marginLeft: "auto", padding: "2px 10px" }} onClick={() => setOpenRun(null)}>Close</button>
            </div>
            {!run ? <div style={{ fontSize: 13, color: "var(--text-3)" }}>Loading…</div> : (
              <>
                <div style={{ fontSize: 12.5, color: "var(--text-3)", marginBottom: 8 }}>
                  {run.run?.run_id} · {run.run?.device ?? "?"} · {run.run?.version ?? "?"}{run.run?.source ? ` · ${run.run.source}` : ""}
                  {run.deal && <> · <Link href={`/crm/deal/${run.deal.id}`} style={{ color: "var(--accent)" }}>{run.deal.title}</Link></>}
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}>Time</th><th style={th}>Event</th><th style={th}>Step</th><th style={th}>Active</th><th style={th}>Detail</th></tr></thead>
                  <tbody>
                    {run.events.map((e, k) => (
                      <tr key={k}>
                        <td style={td}>{new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</td>
                        <td style={td}>{e.name}</td>
                        <td style={td}>{e.step_index ? `${e.step_index} · ` : ""}{e.step ?? ""}</td>
                        <td style={td}>{e.ms != null ? secs(e.ms) : ""}</td>
                        <td style={{ ...td, whiteSpace: "normal", color: "var(--text-2)" }}>{[e.answer, e.data ? Object.entries(e.data).filter(([k2]) => k2 !== "sid").map(([k2, v]) => `${k2}: ${String(v)}`).join(", ") : null].filter(Boolean).join(" — ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
