"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  updateTime: string | null;
  hot: boolean;
  hotReason: string | null;
}

type OwnerScope = "mine" | "unassigned" | "both" | "anyone";

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
    if (!lead?.phone || inCall || awaitingDispo) return;
    dialStartRef.current = new Date().toISOString();
    setInCall(true);
    setCallSec(0);
    callSecRef.current = 0;
    setSess((s) => ({ ...s, dials: s.dials + 1 }));
    // Quo desktop registers as the tel: handler (same handoff the Pipedrive
    // integration uses).
    window.location.href = `tel:${lead.phone}`;
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

  const dropVm = () => {
    if (!inCall) return;
    hangUp();
    finalize("vm_dropped");
  };

  const skip = () => {
    if (!inCall && !awaitingDispo) setLeadIdx((i) => i + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
      if (e.key === "Enter" && !inCall && !awaitingDispo) dial();
      if ((e.key === "v" || e.key === "V") && inCall) dropVm();
      if ((e.key === "e" || e.key === "E") && inCall) hangUp();
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
    if (!activeQueue) return;
    setLoading(true);
    try {
      await loadQueue(activeQueue, ownerScope, nameFilter.trim());
      await loadQueues(ownerScope);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  if (error) return <div className="viewsub">Couldn’t load dialer: {error}</div>;

  return (
    <>
      <h2 className="viewtitle">Dial session</h2>
      <div className="viewsub">
        Queue: <b style={{ color: "var(--text-1)" }}>{activeQueue?.name ?? "—"}</b> · calls place
        through your Quo line · auto-logged to Pipedrive
      </div>

      <div className="dialer-grid">
        {/* left: queues + filter */}
        <div>
          <div className="panel-h">Queues</div>
          <div className="queue-list">
            {queues.map((q) => (
              <div
                key={q.id}
                className={`queue-item ${activeQueue?.id === q.id ? "active" : ""}`}
                onClick={() => {
                  setLoading(true);
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
              <div className="dial-controls">
                <button className="btn primary big" onClick={dial} disabled={inCall || awaitingDispo}>
                  📞 Dial <kbd>⏎</kbd>
                </button>
                <button className="btn big" onClick={dropVm} disabled={!inCall}>
                  🎙 VM left <kbd>V</kbd>
                </button>
                {inCall && (
                  <button className="btn big" style={{ background: "var(--crit)", color: "#fff" }} onClick={hangUp}>
                    ⏹ Call ended <kbd>E</kbd>
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
          <div className="card">
            <div className="panel-h">Up next</div>
            <div className="upnext">
              {leads.slice(leadIdx + 1, leadIdx + 5).map((l) => (
                <div className="row" key={l.dealId}>
                  <span className="who">{l.personName ?? l.title}</span>
                  <span className="why">{l.hot ? "🔥 hot" : l.stageName}</span>
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
        <kbd>1–4</kbd> disposition · <kbd>S</kbd> skip. One-click VM audio drop arrives with the
        desktop companion.
      </div>
    </>
  );
}
