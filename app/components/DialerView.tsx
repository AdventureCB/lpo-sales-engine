"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VmPanel, type VmDrop } from "./VmPanel";

declare global {
  interface Window {
    __TAURI__?: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
  }
}

interface Queue {
  id: string;
  name: string;
  is_primary: boolean;
  count: number | null;
}

interface Lead {
  dealId: number;
  title: string;
  personName: string | null;
  phone: string | null;
  stageName: string;
  updateTime?: string | null;
  hot: boolean;
  hotReason: string | null;
  callable?: boolean; // search results: sales can't dial other reps' deals
  status?: string;
}

type OwnerScope = "mine" | "unassigned" | "both" | "anyone";

const PIPELINES: { id: string; label: string }[] = [
  { id: "", label: "Any pipeline" },
  { id: "6", label: "Intake" },
  { id: "7", label: "Sales / Nurture" },
  { id: "8", label: "Order" },
];

const STAGES_BY_PIPE: Record<string, { id: string; label: string }[]> = {
  "": [],
  "6": [
    { id: "44", label: "Intake- Needs Qualification" },
    { id: "45", label: "Recovery" },
    { id: "46", label: "Qualified" },
    { id: "47", label: "Waiting on Timing" },
  ],
  "7": [
    { id: "48", label: "Qualified" },
    { id: "55", label: "Warm" },
    { id: "54", label: "Cold" },
    { id: "56", label: "Hot" },
    { id: "50", label: "Deposit Placed" },
  ],
  "8": [
    { id: "51", label: "Deposit Placed" },
    { id: "52", label: "Confirmation Scheduled" },
    { id: "53", label: "Confirmed (Won)" },
  ],
};

const DISPOSITIONS: [string, string, string][] = [
  ["connected", "1", "✅ Connected"],
  ["vm_dropped", "2", "🎙 VM left"],
  ["bad_number", "3", "🚫 Bad number"],
  ["callback", "4", "📅 Callback set"],
];

function fmtClock(sec: number) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

export function DialerView({ isAdmin }: { isAdmin: boolean }) {
  const [queues, setQueues] = useState<Queue[]>([]);
  const [activeQueue, setActiveQueue] = useState<Queue | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadIdx, setLeadIdx] = useState(0);
  const [notes, setNotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ownerScope, setOwnerScope] = useState<OwnerScope>(isAdmin ? "anyone" : "both");
  const [nameFilter, setNameFilter] = useState("");
  const [pipeline, setPipeline] = useState("");
  const [stage, setStage] = useState("");
  const [dealStatus, setDealStatus] = useState("open");
  const [queueLabel, setQueueLabel] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<Lead[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [inCall, setInCall] = useState(false);
  const [awaitingDispo, setAwaitingDispo] = useState(false);
  const [callSec, setCallSec] = useState(0);
  const [autoAdv, setAutoAdv] = useState(true);
  const [sess, setSess] = useState({ dials: 0, conn: 0, vm: 0, talkS: 0 });
  const dialStartRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callSecRef = useRef(0);

  const lead = leads[leadIdx] ?? null;

  const loadQueues = useCallback(async (scope: OwnerScope) => {
    const r = await fetch(`/api/dialer/queues?owner=${scope}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    setQueues(d.queues);
    return d.queues as Queue[];
  }, []);

  const loadQueue = useCallback(async (q: Queue, scope: OwnerScope, name: string) => {
    setActiveQueue(q);
    setLeads([]);
    setLeadIdx(0);
    const params = new URLSearchParams({ queueId: q.id, owner: scope });
    if (name) params.set("name", name);
    const r = await fetch(`/api/dialer/queue?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    setLeads(d.leads);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const qs = await loadQueues(ownerScope);
        const primary = qs.find((q) => q.is_primary) ?? qs[0];
        if (primary) await loadQueue(primary, ownerScope, "");
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setNotes([]);
    if (lead) {
      fetch(`/api/dialer/lead?dealId=${lead.dealId}`)
        .then((r) => r.json())
        .then((d) => setNotes(d.notes ?? []));
    }
  }, [lead?.dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopTimers = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    timerRef.current = null;
    pollRef.current = null;
  };

  const dial = () => {
    if (!lead?.phone || inCall || awaitingDispo || lead.callable === false) return;
    dialStartRef.current = new Date().toISOString();
    setInCall(true);
    setCallSec(0);
    callSecRef.current = 0;
    setSess((s) => ({ ...s, dials: s.dials + 1 }));
    // Quo desktop registers as the tel: handler (same handoff the Pipedrive
    // integration uses). The companion webview blocks tel: navigation, so
    // hand it to the OS natively there.
    if (window.__TAURI__) {
      void window.__TAURI__.core
        .invoke("open_tel", { url: `tel:${lead.phone}` })
        .catch((e) => console.error("open_tel failed", e));
    } else {
      window.location.href = `tel:${lead.phone}`;
    }
    timerRef.current = setInterval(() => {
      callSecRef.current += 1;
      setCallSec(callSecRef.current);
    }, 1000);
    // Advance on the call.completed webhook.
    pollRef.current = setInterval(async () => {
      if (!dialStartRef.current || !lead.phone) return;
      const r = await fetch(
        `/api/dialer/call-status?phone=${encodeURIComponent(lead.phone)}&since=${dialStartRef.current}`
      ).catch(() => null);
      if (!r?.ok) return;
      const d = await r.json();
      if (d.call?.completed) hangUp();
    }, 3000);
  };

  const hangUp = () => {
    stopTimers();
    setInCall(false);
    setAwaitingDispo(true);
  };

  const [endCallDiag, setEndCallDiag] = useState<string | null>(null);

  /** End-call button: try to click Quo's own hang-up via the companion. */
  const endCall = async () => {
    if (!inCall) return;
    if (window.__TAURI__) {
      try {
        const result = String(await window.__TAURI__.core.invoke("end_call"));
        setEndCallDiag(result.startsWith("clicked") ? null : result);
      } catch (e) {
        setEndCallDiag(String(e));
      }
    }
    hangUp();
  };

  const sendDisposition = async (dispo: string) => {
    if (!lead?.phone || !dialStartRef.current) return;
    const body = {
      dealId: lead.dealId,
      phone: lead.phone,
      disposition: dispo,
      dialStartedAt: dialStartRef.current,
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch("/api/dialer/disposition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, final: attempt === 3 }),
      }).catch(() => null);
      if (r && r.status !== 202) return;
      await new Promise((res) => setTimeout(res, 4000));
    }
  };

  const finalize = (dispo: string) => {
    setAwaitingDispo(false);
    if (dispo === "connected") setSess((s) => ({ ...s, conn: s.conn + 1, talkS: s.talkS + callSecRef.current }));
    if (dispo === "vm_dropped") setSess((s) => ({ ...s, vm: s.vm + 1 }));
    void sendDisposition(dispo);
    setCallSec(0);
    callSecRef.current = 0;
    if (autoAdv) setLeadIdx((i) => i + 1);
  };

  const [vmDrop, setVmDrop] = useState<VmDrop | null>(null);
  const [vmPlaying, setVmPlaying] = useState(false);

  const dropVm = async () => {
    if (!inCall) return;
    // Inside the desktop companion: play the recording into the virtual
    // audio device (BlackHole) so the voicemail hears it. In a browser
    // there's no audio path into the call — log-only.
    if (window.__TAURI__ && vmDrop?.url) {
      setVmPlaying(true);
      try {
        await window.__TAURI__.core.invoke("play_vm", { url: vmDrop.url });
      } catch (e) {
        console.error("vm playback failed", e);
      }
      setVmPlaying(false);
    }
    hangUp();
    finalize("vm_dropped");
  };

  const logSkip = (l: Lead) => {
    void fetch("/api/dialer/skip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealId: l.dealId, dealTitle: l.title }),
    }).catch(() => {});
  };

  const skip = () => {
    if (inCall || awaitingDispo || !lead) return;
    logSkip(lead);
    setLeadIdx((i) => i + 1);
  };

  /** ✕ on an up-next row: drop it from this session's queue, recorded. */
  const skipUpcoming = (dealId: number) => {
    const target = leads.find((l) => l.dealId === dealId);
    if (target) logSkip(target);
    setLeads((prev) => prev.filter((l) => l.dealId !== dealId));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
      if (e.key === "Enter" && !inCall && !awaitingDispo) dial();
      if ((e.key === "v" || e.key === "V") && inCall) dropVm();
      if ((e.key === "e" || e.key === "E") && inCall) void endCall();
      if ((e.key === "s" || e.key === "S") && !inCall && !awaitingDispo) skip();
      if ((inCall || awaitingDispo) && ["1", "2", "3", "4"].includes(e.key)) {
        if (inCall) hangUp();
        finalize(DISPOSITIONS[Number(e.key) - 1][0]);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCall, awaitingDispo, lead?.dealId, autoAdv]);

  useEffect(() => () => stopTimers(), []);

  const applyFilter = async () => {
    setLoading(true);
    setSearchResults(null);
    try {
      if (pipeline || stage || dealStatus !== "open") {
        // Ad-hoc queue from the filter builder
        setActiveQueue(null);
        const params = new URLSearchParams({ owner: ownerScope, status: dealStatus });
        if (stage) params.set("stageId", stage);
        else if (pipeline) params.set("pipelineId", pipeline);
        if (nameFilter.trim()) params.set("name", nameFilter.trim());
        const r = await fetch(`/api/dialer/queue?${params}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        setLeads(d.leads);
        setLeadIdx(0);
        const stageLabel = stage
          ? STAGES_BY_PIPE[pipeline]?.find((s) => s.id === stage)?.label
          : PIPELINES.find((p) => p.id === pipeline)?.label;
        setQueueLabel(`${stageLabel ?? "All deals"} · ${dealStatus}`);
      } else if (activeQueue) {
        await loadQueue(activeQueue, ownerScope, nameFilter.trim());
        setQueueLabel(null);
      }
      await loadQueues(ownerScope);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const runSearch = async () => {
    const term = searchTerm.trim();
    if (term.length < 2) return;
    setSearching(true);
    try {
      const r = await fetch(`/api/dialer/search?term=${encodeURIComponent(term)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setSearchResults(d.results);
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  };

  const pickSearchResult = (l: Lead) => {
    setActiveQueue(null);
    setQueueLabel(`Search: ${l.title}`);
    setLeads([l]);
    setLeadIdx(0);
    setSearchResults(null);
  };

  if (error) return <div className="viewsub">Couldn’t load dialer: {error}</div>;

  return (
    <>
      <h2 className="viewtitle">Dial session</h2>
      <div className="viewsub">
        Queue: <b style={{ color: "var(--text-1)" }}>{queueLabel ?? activeQueue?.name ?? "—"}</b>
        {leads.length > 0 && (
          <>
            {" "}· <b style={{ color: "var(--text-1)" }}>
              Call {Math.min(leadIdx + 1, leads.length)} / {leads.length}
            </b>
          </>
        )}{" "}
        · calls place through your Quo line · auto-logged to Pipedrive
      </div>

      <div className="dialer-grid">
        {/* left: search + queues + filter */}
        <div>
          <div className="panel-h">Find any deal</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input
              className="vmsel"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              placeholder="Name, deal, email…"
            />
            <button className="btn" style={{ padding: "8px 12px" }} onClick={runSearch}>
              {searching ? "…" : "🔍"}
            </button>
          </div>
          {searchResults && (
            <div className="queue-list" style={{ marginBottom: 12 }}>
              {searchResults.length === 0 && (
                <div style={{ fontSize: 12.5, color: "var(--text-3)", padding: "4px 2px" }}>
                  No deals match.
                </div>
              )}
              {searchResults.map((r) => (
                <div
                  key={r.dealId}
                  className="queue-item"
                  style={{ opacity: r.callable === false ? 0.55 : 1 }}
                  onClick={() => pickSearchResult(r)}
                  title={r.callable === false ? "Owned by another rep — view only" : undefined}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.title}
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-3)", fontWeight: 500 }}>
                      {r.stageName} · {r.status}
                      {r.callable === false ? " · 🔒" : ""}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="panel-h">Queues</div>
          <div className="queue-list">
            {queues.map((q) => (
              <div
                key={q.id}
                className={`queue-item ${activeQueue?.id === q.id ? "active" : ""}`}
                onClick={() => {
                  setLoading(true);
                  setQueueLabel(null);
                  setSearchResults(null);
                  loadQueue(q, ownerScope, nameFilter.trim())
                    .catch((e) => setError(String(e)))
                    .finally(() => setLoading(false));
                }}
              >
                <span>
                  {q.name}
                  {q.is_primary && <span className="prim"> PRIMARY</span>}
                </span>
                <span className="count">{q.count ?? "…"}</span>
              </div>
            ))}
          </div>

          <div className="panel-h" style={{ marginTop: 20 }}>Filter</div>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>Pipeline</label>
            <select
              className="vmsel"
              value={pipeline}
              onChange={(e) => {
                setPipeline(e.target.value);
                setStage("");
              }}
            >
              {PIPELINES.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>Stage</label>
            <select className="vmsel" value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">Any stage</option>
              {(STAGES_BY_PIPE[pipeline] ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>Status</label>
            <select className="vmsel" value={dealStatus} onChange={(e) => setDealStatus(e.target.value)}>
              <option value="open">Open</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>Owner</label>
            <select
              value={ownerScope}
              onChange={(e) => setOwnerScope(e.target.value as OwnerScope)}
              className="vmsel"
            >
              <option value="mine">Owned by me</option>
              <option value="unassigned">No assigned rep</option>
              <option value="both">Mine + unassigned</option>
              {isAdmin && <option value="anyone">Anyone (admin)</option>}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>Deal name includes</label>
            <input
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
              placeholder="e.g. Tacoma, Saved Build…"
            />
          </div>
          <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={applyFilter}>
            Apply filter
          </button>
        </div>

        {/* center: lead card */}
        <div className="card lead-card">
          {loading && <div className="viewsub">Building queue…</div>}
          {!loading && !lead && (
            <div className="viewsub">
              Queue clear — nothing left to dial here. 🎉
            </div>
          )}
          {!loading && lead && (
            <>
              <div className="lead-top">
                <div>
                  <div className="lead-name">{lead.personName ?? lead.title}</div>
                  <div className="lead-phone">
                    {lead.phone} · {lead.title}
                  </div>
                </div>
                <span className="chip stage">{lead.stageName}</span>
              </div>
              <div className="lead-meta">
                {lead.hot && (
                  <span className="chip" style={{ background: "rgba(201,80,46,.16)", color: "#e88a6b" }}>
                    🔥 Hot — {lead.hotReason}
                  </span>
                )}
                <span className="chip stage">Pipedrive ▸ deal open</span>
              </div>
              <div className="lead-notes">
                {notes.length > 0 ? notes.join(" · ") : "No notes on this deal."}
              </div>
              {lead.callable === false && (
                <div className="viewsub" style={{ marginBottom: 12 }}>
                  🔒 Owned by another rep — view only.
                </div>
              )}
              <div className="dial-controls">
                <button
                  className="btn primary big"
                  onClick={dial}
                  disabled={inCall || awaitingDispo || lead.callable === false}
                >
                  📞 Dial <kbd>⏎</kbd>
                </button>
                <button className="btn big" onClick={dropVm} disabled={!inCall || vmPlaying}>
                  {vmPlaying ? "🎙 Dropping…" : <>🎙 Drop VM <kbd>V</kbd></>}
                </button>
                {inCall && (
                  <button className="btn big" style={{ background: "var(--crit)", color: "#fff" }} onClick={endCall}>
                    ⏹ End call <kbd>E</kbd>
                  </button>
                )}
                <button className="btn ghost" onClick={skip} disabled={inCall || awaitingDispo}>
                  Skip <kbd>S</kbd>
                </button>
                {inCall && (
                  <div className="callstate" style={{ display: "flex" }}>
                    <span className="dot" /> {fmtClock(callSec)} — in call via Quo
                  </div>
                )}
              </div>
              {endCallDiag && (
                <pre
                  style={{ marginTop: 12, fontSize: 10.5, color: "var(--text-3)", whiteSpace: "pre-wrap", maxHeight: 140, overflow: "auto", background: "var(--surface-2)", borderRadius: 8, padding: 10 }}
                  onClick={() => setEndCallDiag(null)}
                >
                  hang-up automation: {endCallDiag}
                </pre>
              )}
              {awaitingDispo && (
                <div className="dispo-row" style={{ display: "flex" }}>
                  {DISPOSITIONS.map(([key, num, label]) => (
                    <button key={key} className="btn" onClick={() => finalize(key)}>
                      {label} <kbd>{num}</kbd>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* right: session panel */}
        <div className="side-panel">
          <div className="card">
            <div className="panel-h">This session</div>
            <div className="session-stats">
              <div className="sstat"><div className="n">{sess.dials}</div><div className="l">Dials</div></div>
              <div className="sstat"><div className="n">{sess.conn}</div><div className="l">Connected</div></div>
              <div className="sstat"><div className="n">{sess.vm}</div><div className="l">VMs</div></div>
              <div className="sstat"><div className="n">{Math.round(sess.talkS / 60)}m</div><div className="l">Talk time</div></div>
            </div>
            <div
              className={`toggle ${autoAdv ? "on" : ""}`}
              style={{ marginTop: 14 }}
              onClick={() => setAutoAdv((v) => !v)}
            >
              <span className="tk" /> Auto-advance after call
            </div>
          </div>
          <VmPanel selected={vmDrop} onSelect={setVmDrop} />
          <div className="card">
            <div className="panel-h">Up next</div>
            <div className="upnext">
              {leads.slice(leadIdx + 1, leadIdx + 6).map((l) => (
                <div className="row" key={l.dealId} style={{ alignItems: "center", gap: 8 }}>
                  <span className="who">{l.personName ?? l.title}</span>
                  <span className="why" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {l.hot ? "🔥 hot" : l.stageName}
                    <button
                      className="btn ghost"
                      style={{ padding: "1px 7px", fontSize: 11, lineHeight: 1.4 }}
                      title="Skip — remove from this session (recorded)"
                      onClick={() => skipUpcoming(l.dealId)}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              ))}
              {leads.length <= leadIdx + 1 && (
                <div className="row"><span className="why">End of queue</span></div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="viewsub" style={{ marginTop: 18 }}>
        Keyboard: <kbd>⏎</kbd> dial · <kbd>E</kbd> call ended · <kbd>V</kbd> VM left ·{" "}
        <kbd>1–4</kbd> disposition · <kbd>S</kbd> skip ·{" "}
        {typeof window !== "undefined" && window.__TAURI__
          ? "🖥 companion mode — VM drops play into the call"
          : "🌐 browser mode — VM drops log only (use the desktop app for audio)"}
      </div>
    </>
  );
}
