"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ensurePhone, getPhoneState, newOutboundCall, setOutboundHandler, subscribePhone } from "./phoneClient";
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
  sprintId?: string; // sprint session fields
  crmDealId?: string;
}

type OwnerScope = "mine" | "unassigned" | "both" | "anyone";

const PIPELINES: { id: string; label: string }[] = [
  { id: "", label: "Any pipeline" },
  { id: "6", label: "Intake" },
  { id: "7", label: "Sales / Nurture" },
  { id: "8", label: "Order" },
  { id: "9", label: "Base Camp List" },
  { id: "10", label: "Re-Prospect Pool" },
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
  "9": [
    { id: "57", label: "Price" },
    { id: "58", label: "Shipping" },
    { id: "59", label: "Straight pop" },
    { id: "60", label: "Timing" },
    { id: "61", label: "Other" },
  ],
  "10": [
    { id: "62", label: "Lead Pool" },
    { id: "64", label: "Email Only" },
    { id: "63", label: "Archive/Do Not Call" },
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

/** Progressive (555) 123-4567 formatting for the keypad display. */
function fmtDialed(digits: string) {
  const n = digits.replace(/^1/, "");
  if (!n) return "";
  if (n.length <= 3) return `(${n}`;
  if (n.length <= 6) return `(${n.slice(0, 3)}) ${n.slice(3)}`;
  return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6, 10)}`;
}

export function DialerView({ isAdmin }: { isAdmin: boolean }) {
  const [queues, setQueues] = useState<Queue[]>([]);
  const [activeQueue, setActiveQueue] = useState<Queue | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadIdx, setLeadIdx] = useState(0);
  const [notes, setNotes] = useState<string[]>([]);
  const [activities, setActivities] = useState<
    { type: string; subject: string | null; done: boolean; due_date: string | null; add_time: string | null }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queueMeta, setQueueMeta] = useState<{
    skippedNoPhone: number;
    skippedOwnership: number;
    truncated: boolean;
    pool?: { eligible: number; coolingDown: number; leasedByOthers: number };
  } | null>(null);
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
  // How calls are placed: Quo desktop app (tel: handoff), Quo web (clipboard
  // handoff), or in-tab browser calling via Telnyx WebRTC. Sticky per machine.
  const [dialMethod, setDialMethod] = useState<"desktop" | "web" | "browser">("desktop");
  useEffect(() => {
    const m = localStorage.getItem("dialMethod");
    if (m === "web" || m === "browser") setDialMethod(m);
  }, []);
  const pickDialMethod = (m: "desktop" | "web" | "browser") => {
    setDialMethod(m);
    localStorage.setItem("dialMethod", m);
  };
  const telnyxCallRef = useRef<any>(null);
  const [browserCallState, setBrowserCallState] = useState<string | null>(null);
  const [browserStats, setBrowserStats] = useState<string | null>(null);
  const statsRef = useRef<{ iv: ReturnType<typeof setInterval> | null; prev: { lost: number; recv: number } | null }>({ iv: null, prev: null });
  // Per-call quality aggregate — logged with the disposition.
  const qualityRef = useRef<{ sumLoss: number; maxJitter: number; samples: number }>({ sumLoss: 0, maxJitter: 0, samples: 0 });

  const stopStats = () => {
    if (statsRef.current.iv) clearInterval(statsRef.current.iv);
    statsRef.current = { iv: null, prev: null };
    setBrowserStats(null);
  };

  /** Poll WebRTC inbound stats — makes "it sounded choppy" measurable. */
  const startStats = () => {
    stopStats();
    let misses = 0;
    statsRef.current.iv = setInterval(async () => {
      try {
        const call = telnyxCallRef.current;
        const pc =
          call?.peer?.instance ?? call?.peerConnection ?? call?.session?.peerConnection ?? call?.pc ?? null;
        if (!pc?.getStats) {
          if (++misses === 3) setBrowserStats("stats unavailable in this SDK build");
          return;
        }
        const stats: any[] = [];
        (await pc.getStats()).forEach((s: any) => stats.push(s));
        const inbound = stats.find((s) => s.type === "inbound-rtp" && (s.kind === "audio" || s.mediaType === "audio"));
        if (!inbound) return;
        const prev = statsRef.current.prev;
        statsRef.current.prev = { lost: inbound.packetsLost ?? 0, recv: inbound.packetsReceived ?? 0 };
        if (!prev) return;
        const dLost = (inbound.packetsLost ?? 0) - prev.lost;
        const dRecv = (inbound.packetsReceived ?? 0) - prev.recv;
        const lossPct = dRecv + dLost > 0 ? (100 * dLost) / (dRecv + dLost) : 0;
        const jitterMs = Math.round((inbound.jitter ?? 0) * 1000);
        qualityRef.current.sumLoss += lossPct;
        qualityRef.current.maxJitter = Math.max(qualityRef.current.maxJitter, jitterMs);
        qualityRef.current.samples++;
        setBrowserStats(`▼ loss ${lossPct.toFixed(1)}% · jitter ${jitterMs}ms`);
      } catch {}
    }, 5000);
  };

  // Softphone connection state comes from the app-wide singleton (survives
  // navigation; PhoneDock renders the inbound banner on every page).
  const [telnyxConn, setTelnyxConn] = useState<string>("off");
  useEffect(() => {
    const sync = () => setTelnyxConn(getPhoneState().conn);
    sync();
    const unsub = subscribePhone(sync);
    return unsub;
  }, []);

  // The dialer owns OUTBOUND call state — register its handler with the
  // singleton while mounted.
  useEffect(() => {
    setOutboundHandler((c: any, s: string) => {
      telnyxCallRef.current = c; // notifications carry the live call object
      if (s === "active") {
        setBrowserCallState("active");
        startStats();
      }
      if (s === "ringing" || s === "trying" || s === "requesting") setBrowserCallState("ringing");
      if (s === "hangup" || s === "destroy") {
        setBrowserCallState(null);
        telnyxCallRef.current = null;
        stopStats();
        hangUp();
      }
    });
    return () => setOutboundHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser mode keeps the connection warm so inbound calls ring anywhere.
  useEffect(() => {
    if (dialMethod === "browser") {
      ensurePhone().catch((e) => console.error("telnyx connect", e));
    }
  }, [dialMethod]);

  /** In-app call via Telnyx WebRTC — the post-Quo path being piloted. */
  const browserCall = async (phone: string) => {
    setBrowserCallState("connecting");
    try {
      // Pre-flight: surface mic problems BEFORE the call instead of a
      // mysterious drop at answer time (blocked mic rings fine, then dies).
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        mic.getTracks().forEach((t) => t.stop());
      } catch (me: any) {
        const blocked = me?.name === "NotAllowedError" || me?.name === "PermissionDeniedError";
        setBrowserCallState(
          blocked
            ? "error: microphone blocked — click the mic/camera icon by the address bar, choose Allow, reload, and dial again"
            : `error: microphone unavailable (${me?.name ?? "unknown"}) — check input device in system settings`
        );
        hangUp();
        return;
      }
      const call = await newOutboundCall(phone);
      telnyxCallRef.current = call;
      setBrowserCallState("ringing");
    } catch (e) {
      setBrowserCallState(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const [awaitingDispo, setAwaitingDispo] = useState(false);
  const [callSec, setCallSec] = useState(0);
  const [autoAdv, setAutoAdv] = useState(true);
  const [sess, setSess] = useState({ dials: 0, conn: 0, vm: 0, talkS: 0 });
  const dialStartRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callSecRef = useRef(0);

  const lead = leads[leadIdx] ?? null;

  // Manual dial: keypad popup → call. Before dialing we match the number
  // against the CRM — a found deal rides the normal disposition/logging flow;
  // an unknown number gets the "add a deal?" offer after hang-up.
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [keypadNum, setKeypadNum] = useState(""); // digits only
  const [keypadBusy, setKeypadBusy] = useState(false);
  const keypadDigits = keypadNum.replace(/^1/, "");
  const keypadValid = keypadDigits.length === 10;

  // "No deal matched — add one?" flow after a manual call ends.
  const [manualDealStage, setManualDealStage] = useState<"ask" | "form" | "skip">("ask");
  const [mdName, setMdName] = useState("");
  const [mdEmail, setMdEmail] = useState("");
  const [mdTitle, setMdTitle] = useState("");
  const [mdSaving, setMdSaving] = useState(false);
  const [mdError, setMdError] = useState<string | null>(null);
  const resetMdForm = () => {
    setMdName("");
    setMdEmail("");
    setMdTitle("");
    setMdError(null);
    setManualDealStage("ask");
  };

  const keypadCall = async () => {
    if (!keypadValid || inCall || awaitingDispo || keypadBusy) return;
    setKeypadBusy(true);
    const e164 = `+1${keypadDigits}`;
    let matched: {
      name: string | null;
      crmDealId: string | null;
      pipedriveDealId: number | null;
      dealTitle: string | null;
    } | null = null;
    try {
      const r = await fetch(`/api/crm/contact-by-phone?phone=${encodeURIComponent(e164)}`);
      const d = r.ok ? await r.json() : null;
      if (d?.contact) {
        matched = {
          name: d.contact.name ?? null,
          crmDealId: d.deal?.crmDealId ?? null,
          pipedriveDealId: d.deal?.pipedriveDealId ?? null,
          dealTitle: d.deal?.title ?? null,
        };
      }
    } catch {}
    const synthetic: Lead = {
      dealId: matched?.pipedriveDealId ?? 0,
      title: matched?.dealTitle ?? `Manual dial ${e164}`,
      personName: matched?.name ?? null,
      phone: e164,
      stageName: "manual",
      hot: false,
      hotReason: null,
      crmDealId: matched?.crmDealId ?? undefined,
    };
    setLeads((prev) => [...prev.slice(0, leadIdx), synthetic, ...prev.slice(leadIdx)]);
    resetMdForm();
    setKeypadBusy(false);
    dial({ leadOverride: synthetic });
  };

  const createManualDeal = async () => {
    if (!lead?.phone || !mdName.trim() || mdSaving) return;
    setMdSaving(true);
    setMdError(null);
    try {
      const r = await fetch("/api/crm/create-deal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: lead.phone,
          name: mdName.trim(),
          email: mdEmail.trim() || undefined,
          title: mdTitle.trim() || undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      // Attach the new (or linked) deal to the in-flight lead so the
      // disposition that follows logs to it.
      setLeads((prev) =>
        prev.map((x, i) =>
          i === leadIdx
            ? {
                ...x,
                dealId: d.pipedriveDealId ?? 0,
                crmDealId: d.crmDealId ?? undefined,
                title: d.title ?? x.title,
                personName: mdName.trim(),
              }
            : x
        )
      );
      setManualDealStage("skip");
    } catch (e) {
      setMdError(e instanceof Error ? e.message : String(e));
    } finally {
      setMdSaving(false);
    }
  };

  // A manual dial that matched nothing in the CRM — after hang-up, offer to
  // create a deal before the disposition is taken.
  const isManualNoDeal = !!lead && lead.stageName === "manual" && !lead.dealId && !lead.crmDealId;

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
    setQueueMeta({
      skippedNoPhone: d.skippedNoPhone ?? 0,
      skippedOwnership: d.skippedOwnership ?? 0,
      truncated: d.truncated ?? false,
      pool: d.pool,
    });
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
    setActivities([]);
    if (lead) {
      fetch(`/api/dialer/lead?dealId=${lead.dealId}`)
        .then((r) => r.json())
        .then((d) => {
          setNotes(d.notes ?? []);
          setActivities(d.activities ?? []);
        });
    }
  }, [lead?.dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopTimers = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    timerRef.current = null;
    pollRef.current = null;
  };

  const dial = (opts?: { redial?: boolean; leadOverride?: Lead }) => {
    const l = opts?.leadOverride ?? lead;
    if (!l?.phone || inCall || (awaitingDispo && !opts?.redial) || l.callable === false) return;
    if (opts?.redial) {
      setAwaitingDispo(false);
      setPendingDispo(null);
    }
    qualityRef.current = { sumLoss: 0, maxJitter: 0, samples: 0 };
    dialStartRef.current = new Date().toISOString();
    setInCall(true);
    setCallSec(0);
    callSecRef.current = 0;
    setSess((s) => ({ ...s, dials: s.dials + 1 }));
    // Record the attempt — drives the shared pool's cooldown + fairness,
    // and marks sprint items as called. Manual dials have no deal to log.
    if (l.dealId) {
      void fetch("/api/dialer/attempt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: l.dealId, sprintId: l.sprintId, crmDealId: l.crmDealId }),
      }).catch(() => {});
    }
    if (dialMethod === "browser") {
      void browserCall(l.phone);
    } else if (dialMethod === "web") {
      // Quo web (my.quo.com) has no dial deep-link, so the fastest handoff is
      // clipboard: number is copied, rep pastes into the Quo tab. Tracking is
      // unaffected — webhooks record the call wherever it's placed.
      void navigator.clipboard?.writeText(l.phone).catch(() => {});
    } else if (window.__TAURI__) {
      // Quo desktop registers as the tel: handler (same handoff the Pipedrive
      // integration uses). The companion webview blocks tel: navigation, so
      // hand it to the OS natively there.
      void window.__TAURI__.core
        .invoke("open_tel", { url: `tel:${l.phone}` })
        .catch((e) => console.error("open_tel failed", e));
    } else {
      window.location.href = `tel:${l.phone}`;
    }
    timerRef.current = setInterval(() => {
      callSecRef.current += 1;
      setCallSec(callSecRef.current);
    }, 1000);
    // Advance on the call.completed webhook.
    pollRef.current = setInterval(async () => {
      if (!dialStartRef.current || !l.phone) return;
      const r = await fetch(
        `/api/dialer/call-status?phone=${encodeURIComponent(l.phone)}&since=${dialStartRef.current}`
      ).catch(() => null);
      if (!r?.ok) return;
      const d = await r.json();
      if (d.call?.completed) hangUp();
    }, 3000);
  };

  const hangUp = () => {
    stopTimers();
    setInCall(false);
    setKeypadOpen(false); // keypad's job is done — disposition happens in the lead card
    setAwaitingDispo(true);
  };

  /** End the call for real: companion sends Quo's ⇧⌘H end-call shortcut.
   * In web mode the call lives in the Quo browser tab — nothing to send. */
  const endCall = async () => {
    if (!inCall) return;
    if (dialMethod === "browser") {
      try { telnyxCallRef.current?.hangup(); } catch {}
      setBrowserCallState(null);
    } else if (window.__TAURI__ && dialMethod !== "web") {
      await window.__TAURI__.core.invoke("end_call").catch((e) => console.error("end_call", e));
    }
    hangUp();
  };

  const sendDisposition = async (
    dispo: string,
    next: { type: string; subject: string; dueAt: string } | null,
    note: string | null
  ) => {
    if (!lead?.phone || !dialStartRef.current) return;
    const q = qualityRef.current;
    const body = {
      dealId: lead.dealId || undefined,
      phone: lead.phone,
      disposition: dispo,
      dialStartedAt: dialStartRef.current,
      sprintId: lead.sprintId,
      crmDealId: lead.crmDealId,
      next,
      note,
      quality:
        q.samples > 0
          ? {
              avg_loss_pct: Number((q.sumLoss / q.samples).toFixed(2)),
              max_jitter_ms: q.maxJitter,
              samples: q.samples,
              method: dialMethod,
            }
          : null,
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

  // Two-step disposition: pick the outcome, then (optionally) schedule the
  // next touch in the same gesture — no separate trip to the deal page.
  const [pendingDispo, setPendingDispo] = useState<string | null>(null);
  const [nextType, setNextType] = useState("call");
  const [dispoNote, setDispoNote] = useState("");
  const [customDue, setCustomDue] = useState("");
  const [showCustomDue, setShowCustomDue] = useState(false);
  const finalize = (dispo: string) => setPendingDispo(dispo);

  const followUpAt = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  };

  const completeDispo = (dueAt: string | null) => {
    const dispo = pendingDispo;
    if (!dispo) return;
    setPendingDispo(null);
    setShowCustomDue(false);
    setCustomDue("");
    setAwaitingDispo(false);
    if (dispo === "connected") setSess((s) => ({ ...s, conn: s.conn + 1, talkS: s.talkS + callSecRef.current }));
    if (dispo === "vm_dropped") setSess((s) => ({ ...s, vm: s.vm + 1 }));
    const FOLLOW_UP_SUBJECT: Record<string, string> = {
      connected: "Continue conversation",
      vm_dropped: "Follow up — voicemail left",
      callback: "Callback requested",
      bad_number: "Follow up — fix number first",
    };
    void sendDisposition(
      dispo,
      dueAt ? { type: nextType, subject: FOLLOW_UP_SUBJECT[dispo] ?? "Follow up", dueAt } : null,
      dispoNote.trim() || null
    );
    setDispoNote("");
    setCallSec(0);
    callSecRef.current = 0;
    resetMdForm();
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

  // Keypad popup owns the keyboard while open (digits type into the number).
  useEffect(() => {
    if (!keypadOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (inCall) return; // in-call controls are buttons only
      if (/^[0-9]$/.test(e.key)) setKeypadNum((n) => (n.length < 11 ? n + e.key : n));
      else if (e.key === "Backspace") setKeypadNum((n) => n.slice(0, -1));
      else if (e.key === "Enter") void keypadCall();
      else if (e.key === "Escape") setKeypadOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keypadOpen, inCall, keypadNum, keypadBusy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keypadOpen) return; // keypad effect handles its own keys
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
      if (e.key === "Enter" && !inCall && !awaitingDispo) dial();
      if (e.key === "Enter" && pendingDispo) completeDispo(null);
      if ((e.key === "r" || e.key === "R") && awaitingDispo && !pendingDispo) dial({ redial: true });
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
  }, [inCall, awaitingDispo, pendingDispo, nextType, dispoNote, lead?.dealId, autoAdv, keypadOpen]);

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
        setQueueMeta({
          skippedNoPhone: d.skippedNoPhone ?? 0,
          skippedOwnership: d.skippedOwnership ?? 0,
          truncated: d.truncated ?? false,
          pool: d.pool,
        });
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
        {queueMeta && (queueMeta.skippedNoPhone > 0 || queueMeta.skippedOwnership > 0) && (
          <span style={{ color: "var(--text-3)" }}>
            {" "}· excluded: {queueMeta.skippedNoPhone > 0 ? `${queueMeta.skippedNoPhone} without phone` : ""}
            {queueMeta.skippedNoPhone > 0 && queueMeta.skippedOwnership > 0 ? ", " : ""}
            {queueMeta.skippedOwnership > 0 ? `${queueMeta.skippedOwnership} other-owner` : ""}
          </span>
        )}
        {queueMeta?.truncated && (
          <span style={{ color: "var(--warn)" }}> · ⚠ list capped at 3000 deals</span>
        )}
        {queueMeta?.pool && (
          <span style={{ color: "var(--text-3)" }}>
            {" "}· shared pool: {queueMeta.pool.eligible} eligible
            {queueMeta.pool.coolingDown > 0 && `, ${queueMeta.pool.coolingDown} cooling down (2d)`}
            {queueMeta.pool.leasedByOthers > 0 && `, ${queueMeta.pool.leasedByOthers} with another rep`}
          </span>
        )}
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
                <div style={{ fontSize: 13.5, color: "var(--text-3)", padding: "4px 2px" }}>
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
                    <span style={{ display: "block", fontSize: 12, color: "var(--text-3)", fontWeight: 500 }}>
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
              {activities.length > 0 && (
                <div style={{ marginBottom: 22 }}>
                  <div className="panel-h">Recent activity</div>
                  {activities.map((a, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "baseline",
                        padding: "5px 0",
                        fontSize: 14,
                        borderBottom: i < activities.length - 1 ? "1px solid var(--border-soft)" : "none",
                      }}
                    >
                      <span>
                        {{ call: "📞", meeting: "📅", email: "✉️", task: "📋", deadline: "⏰", lunch: "🍽" }[a.type] ?? "📋"}
                      </span>
                      <span style={{ color: "var(--text-1)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.subject ?? a.type}
                      </span>
                      <span style={{ color: "var(--text-3)", fontSize: 13, whiteSpace: "nowrap" }}>
                        {a.done ? "✓ " : "due "}
                        {(a.due_date ?? a.add_time ?? "").slice(0, 10)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {lead.callable === false && (
                <div className="viewsub" style={{ marginBottom: 12 }}>
                  🔒 Owned by another rep — view only.
                </div>
              )}
              <div className="dial-controls">
                <button
                  className="btn primary big"
                  onClick={() => dial()}
                  disabled={inCall || awaitingDispo || lead.callable === false}
                >
                  📞 Dial <kbd>⏎</kbd>
                </button>
                <button className="btn big" onClick={dropVm} disabled={!inCall || vmPlaying}>
                  {vmPlaying ? "🎙 Dropping…" : <>🎙 Drop VM <kbd>V</kbd></>}
                </button>
                {inCall && (
                  <button
                    className="btn big"
                    style={{ background: "var(--crit)", color: "#fff" }}
                    onClick={endCall}
                  >
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
              {inCall && dialMethod === "browser" && browserCallState && (
                <div style={{ fontSize: 13.5, color: browserCallState.startsWith("error") ? "var(--crit)" : "var(--text-2)", marginTop: 8 }}>
                  {browserCallState === "connecting" && "🌐 Connecting…"}
                  {browserCallState === "ringing" && "🌐 Ringing — in-browser call via Telnyx"}
                  {browserCallState === "active" && (
                    <>
                      🌐 Live — talking through this tab{browserStats ? ` · ${browserStats}` : ""}
                      <span style={{ display: "block", color: "var(--warn, #d9a234)", marginTop: 2 }}>
                        📼 This call is recorded — let the caller know
                      </span>
                    </>
                  )}
                  {browserCallState.startsWith("error") && `🌐 ${browserCallState}`}
                </div>
              )}
              {inCall && dialMethod === "web" && (
                <div style={{ fontSize: 13.5, color: "var(--text-2)", marginTop: 8 }}>
                  📋 Number copied — switch to the{" "}
                  <a
                    href="https://my.quo.com"
                    target="quo-web"
                    style={{ color: "var(--accent-hover)" }}
                  >
                    Quo web tab
                  </a>
                  , paste into the dialer (⌘V) and call
                </div>
              )}
              {awaitingDispo && !pendingDispo && isManualNoDeal && manualDealStage === "ask" && (
                <div className="dispo-row" style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13.5, color: "var(--text-2)" }}>
                    No deal matches {lead.phone} — add one?
                  </span>
                  <button className="btn primary" onClick={() => setManualDealStage("form")}>
                    ➕ Add a deal
                  </button>
                  <button className="btn ghost" onClick={() => setManualDealStage("skip")}>
                    Just log the call
                  </button>
                </div>
              )}
              {awaitingDispo && !pendingDispo && isManualNoDeal && manualDealStage === "form" && (
                <div style={{ display: "grid", gap: 8, maxWidth: 440, marginTop: 10 }}>
                  <input
                    className="vmsel"
                    placeholder="Contact name (required)"
                    value={mdName}
                    onChange={(e) => setMdName(e.target.value)}
                    autoFocus
                  />
                  <input
                    className="vmsel"
                    placeholder="Email (optional)"
                    value={mdEmail}
                    onChange={(e) => setMdEmail(e.target.value)}
                  />
                  <input
                    className="vmsel"
                    placeholder={`Deal title (default: Phone Lead - ${mdName.trim() || "name"})`}
                    value={mdTitle}
                    onChange={(e) => setMdTitle(e.target.value)}
                  />
                  {mdError && <div style={{ color: "var(--crit)", fontSize: 13.5 }}>{mdError}</div>}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="btn primary"
                      disabled={!mdName.trim() || mdSaving}
                      onClick={createManualDeal}
                    >
                      {mdSaving ? "Creating…" : "Create deal"}
                    </button>
                    <button className="btn ghost" onClick={() => setManualDealStage("skip")}>
                      Skip — just log the call
                    </button>
                  </div>
                </div>
              )}
              {awaitingDispo && !pendingDispo && !(isManualNoDeal && manualDealStage !== "skip") && (
                <div className="dispo-row" style={{ display: "flex" }}>
                  {DISPOSITIONS.map(([key, num, label]) => (
                    <button key={key} className="btn" onClick={() => finalize(key)}>
                      {label} <kbd>{num}</kbd>
                    </button>
                  ))}
                  <button className="btn ghost" onClick={() => dial({ redial: true })} title="Call this contact again — no disposition logged yet">
                    ↺ Redial <kbd>R</kbd>
                  </button>
                </div>
              )}
              {awaitingDispo && pendingDispo && (
                <div style={{ marginTop: 10 }}>
                  <input
                    className="vmsel"
                    style={{ width: "100%", marginBottom: 8 }}
                    placeholder="Add a note about this call… (optional, saves to the deal)"
                    value={dispoNote}
                    onChange={(e) => setDispoNote(e.target.value)}
                  />
                  <div className="dispo-row" style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13.5, color: "var(--text-2)" }}>Next step?</span>
                    <select className="vmsel" style={{ width: "auto", padding: "6px 8px", fontSize: 13.5 }} value={nextType} onChange={(e) => setNextType(e.target.value)}>
                      <option value="call">📞 Call</option>
                      <option value="task">📋 Task</option>
                      <option value="email">✉️ Email</option>
                      <option value="meeting">📅 Meeting</option>
                    </select>
                    <button className="btn" onClick={() => completeDispo(followUpAt(7))}>1 week</button>
                    <button className="btn" onClick={() => completeDispo(followUpAt(14))}>2 weeks</button>
                    <button className="btn" onClick={() => completeDispo(followUpAt(30))}>1 month</button>
                    <button className="btn" onClick={() => setShowCustomDue((v) => !v)}>📅 Custom…</button>
                    <button className="btn ghost" onClick={() => completeDispo(null)}>
                      No follow-up <kbd>⏎</kbd>
                    </button>
                  </div>
                  {showCustomDue && (
                    <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                      <input
                        type="datetime-local"
                        className="vmsel"
                        style={{ width: "auto" }}
                        value={customDue}
                        onChange={(e) => setCustomDue(e.target.value)}
                      />
                      <button
                        className="btn primary"
                        style={{ padding: "7px 14px", fontSize: 14 }}
                        disabled={!customDue}
                        onClick={() => completeDispo(new Date(customDue).toISOString())}
                      >
                        Schedule
                      </button>
                    </div>
                  )}
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
                      style={{ padding: "1px 7px", fontSize: 12, lineHeight: 1.4 }}
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

      <div className="viewsub" style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span>
          Keyboard: <kbd>⏎</kbd> dial · <kbd>E</kbd> call ended · <kbd>V</kbd> VM left ·{" "}
          <kbd>1–4</kbd> disposition · <kbd>S</kbd> skip ·{" "}
          {typeof window !== "undefined" && window.__TAURI__
            ? "🖥 companion mode — VM drops play into the call"
            : "🌐 browser mode — VM drops log only (use the desktop app for audio)"}
        </span>
        <button
          className="btn ghost"
          style={{ padding: "4px 12px", fontSize: 13.5 }}
          onClick={() => {
            setKeypadNum("");
            setKeypadOpen(true);
          }}
          disabled={inCall || awaitingDispo}
          title={awaitingDispo ? "Finish the current disposition first" : undefined}
        >
          ⌨️ Manual dial
        </button>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          Call via
          <select
            className="vmsel"
            style={{ width: "auto", padding: "4px 8px", fontSize: 13.5 }}
            value={dialMethod}
            onChange={(e) => pickDialMethod(e.target.value as "desktop" | "web")}
          >
            <option value="desktop">Quo desktop app</option>
            <option value="web">Quo web (copies number)</option>
            <option value="browser">In-app call (Telnyx pilot)</option>
          </select>
          {dialMethod === "web" && (
            <button
              className="btn ghost"
              style={{ padding: "4px 10px", fontSize: 13.5 }}
              onClick={() => window.open("https://my.quo.com", "quo-web")}
            >
              Open Quo web ↗
            </button>
          )}
          {dialMethod === "browser" && (
            <span
              style={{
                fontSize: 12.5,
                color: telnyxConn === "ready" ? "var(--ok, #0ca30c)" : telnyxConn.startsWith("error") ? "var(--crit)" : "var(--text-3)",
              }}
              title="Inbound calls ring here only while this shows ready"
            >
              {telnyxConn === "ready" ? "🟢 ready — inbound rings here" : `⚪ ${telnyxConn}`}
            </span>
          )}
        </span>
      </div>

      {keypadOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 900,
            background: "rgba(0,0,0,0.55)",
            display: "grid",
            placeItems: "center",
          }}
          onClick={() => {
            if (!inCall) setKeypadOpen(false);
          }}
        >
          <div
            style={{
              background: "var(--surface-1)",
              border: "1px solid var(--border-soft)",
              borderRadius: 16,
              padding: "20px 24px 24px",
              width: 300,
              boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <b style={{ fontSize: 14.5 }}>⌨️ Manual dial</b>
              {!inCall && (
                <button
                  className="btn ghost"
                  style={{ marginLeft: "auto", padding: "2px 9px", fontSize: 14 }}
                  onClick={() => setKeypadOpen(false)}
                >
                  ✕
                </button>
              )}
            </div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                textAlign: "center",
                minHeight: 32,
                marginBottom: 12,
                color: keypadDigits ? "var(--text-1)" : "var(--text-3)",
              }}
            >
              {fmtDialed(keypadNum) || "Enter a number"}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((k, i) =>
                k === "" ? (
                  <span key={i} />
                ) : (
                  <button
                    key={i}
                    className="btn"
                    style={{ padding: "13px 0", fontSize: 17, justifyContent: "center" }}
                    disabled={inCall}
                    onClick={() =>
                      k === "⌫"
                        ? setKeypadNum((n) => n.slice(0, -1))
                        : setKeypadNum((n) => (n.length < 11 ? n + k : n))
                    }
                  >
                    {k}
                  </button>
                )
              )}
            </div>
            {!inCall ? (
              <button
                className="btn primary"
                style={{ width: "100%", justifyContent: "center", padding: "11px 0", fontSize: 15 }}
                disabled={!keypadValid || keypadBusy}
                onClick={keypadCall}
              >
                {keypadBusy ? "Checking CRM…" : "📞 Call"}
              </button>
            ) : (
              <>
                <div className="callstate" style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
                  <span className="dot" /> {fmtClock(callSec)}
                  {dialMethod === "browser" && browserCallState ? ` · ${browserCallState}` : ""}
                </div>
                <button
                  className="btn"
                  style={{
                    width: "100%",
                    justifyContent: "center",
                    padding: "11px 0",
                    fontSize: 15,
                    background: "var(--crit)",
                    color: "#fff",
                  }}
                  onClick={endCall}
                >
                  ⏹ End call
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
