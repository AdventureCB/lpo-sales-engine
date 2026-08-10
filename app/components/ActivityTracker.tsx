"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { getPhoneState, subscribePhone } from "./phoneClient";

/**
 * Rep engagement tracker (admin KPI: ≥4h/day engaged in calling).
 *
 * Renderless, mounted once in the root layout. Event-sourced: it records
 * state-transition intervals (talking / dialing / between / other) in
 * performance.now() time, buffers them, and flushes every ~25s — the open
 * interval rides along and grows in place server-side (idempotent by
 * client_interval_id). Liveness is fail-closed: if flushes stop (sleep,
 * crash, network), credit simply stops at the last witnessed moment.
 *
 * Accuracy rules:
 * - During an active call (phoneClient.callPhase), input recency is ignored
 *   — talking hands-off-keyboard is engaged. (Quo-dialed calls don't set
 *   callPhase; the server overlays authoritative call_events at read time.)
 * - Idle: no input for idle_ms, or tab hidden. On idle we retro-close the
 *   interval at lastInput + a small tail credit, not at detection time.
 * - "between" requires a calling surface (config prefixes); other routes
 *   log as "other" which the KPI excludes.
 */

type TrackState = "talking" | "dialing" | "between" | "other";

interface Cfg {
  idle_ms: number;
  heartbeat_ms: number;
  idle_tail_credit_ms: number;
  calling_prefixes: string[];
}

interface OpenInterval {
  cid: string;
  state: TrackState;
  surface: string;
  startPerf: number;
}

let running = false; // module guard: dev strict-mode double mount, single tracker per tab

const tracker = {
  cfg: null as Cfg | null,
  deviceId: "",
  pathname: "/",
  lastInputPerf: 0,
  open: null as OpenInterval | null,
  done: [] as { cid: string; state: TrackState; surface: string; startPerf: number; endPerf: number }[],
  timers: [] as ReturnType<typeof setInterval>[],
};

function surfaceOf(path: string, cfg: Cfg): { calling: boolean; surface: string } {
  const hit = cfg.calling_prefixes.find((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"));
  return { calling: !!hit, surface: hit ?? path.split("?")[0].split("/").slice(0, 2).join("/") };
}

function desiredState(): { state: TrackState; surface: string } | null {
  const cfg = tracker.cfg!;
  const phase = getPhoneState().callPhase;
  const { calling, surface } = surfaceOf(tracker.pathname, cfg);
  if (phase === "talking") return { state: "talking", surface };
  if (phase === "dialing") return { state: "dialing", surface };
  if (typeof document !== "undefined" && document.hidden) return null;
  if (performance.now() - tracker.lastInputPerf > cfg.idle_ms) return null;
  return calling ? { state: "between", surface } : { state: "other", surface };
}

function closeOpen(endPerf: number) {
  const o = tracker.open;
  if (!o) return;
  if (endPerf > o.startPerf + 500) {
    tracker.done.push({ ...o, endPerf: Math.min(endPerf, performance.now()) });
  }
  tracker.open = null;
}

function evaluate() {
  if (!tracker.cfg) return;
  const want = desiredState();
  const o = tracker.open;
  if (o && (!want || want.state !== o.state || want.surface !== o.surface)) {
    // Idle-close credits a short tail after the last input; anything else
    // (state switch, tab hidden) closes at the actual moment.
    const idleClose = !want && !document.hidden && getPhoneState().callPhase === "none";
    const end = idleClose
      ? Math.min(tracker.lastInputPerf + tracker.cfg.idle_tail_credit_ms, performance.now())
      : performance.now();
    closeOpen(end);
  }
  if (want && !tracker.open) {
    tracker.open = { cid: crypto.randomUUID(), state: want.state, surface: want.surface, startPerf: performance.now() };
  }
}

function payload(final: boolean) {
  const perfNow = performance.now();
  const intervals = tracker.done.map((d) => ({
    cid: d.cid, state: d.state, surface: d.surface, startPerf: d.startPerf, endPerf: d.endPerf,
  }));
  if (tracker.open) {
    intervals.push({
      cid: tracker.open.cid, state: tracker.open.state, surface: tracker.open.surface,
      startPerf: tracker.open.startPerf, endPerf: perfNow,
    });
    if (final) tracker.open = null;
  }
  return { deviceId: tracker.deviceId, perfNow, intervals };
}

async function flush() {
  if (!tracker.cfg || (tracker.done.length === 0 && !tracker.open)) return;
  const body = payload(false);
  if (body.intervals.length === 0) return;
  try {
    const r = await fetch("/api/activity/flush", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
    if (r.ok) tracker.done = []; // open interval stays; server grows it by cid
    else if (r.status === 401) tracker.cfg = null; // logged out — go dormant until next probe
  } catch {
    // network hiccup: keep the buffer, next flush retries (idempotent by cid)
  }
}

function beaconFinal() {
  if (!tracker.cfg) return;
  evaluate();
  const body = payload(true);
  if (body.intervals.length === 0) return;
  try {
    navigator.sendBeacon("/api/activity/flush", new Blob([JSON.stringify(body)], { type: "application/json" }));
    tracker.done = [];
  } catch {}
}

async function probe() {
  try {
    const r = await fetch("/api/activity/flush");
    if (r.ok) {
      const d = await r.json();
      tracker.cfg = d.config;
    }
  } catch {}
}

export function ActivityTracker() {
  const pathname = usePathname();
  tracker.pathname = pathname ?? "/";

  useEffect(() => {
    // Route change is a potential surface transition.
    if (running) evaluate();
  }, [pathname]);

  useEffect(() => {
    if (running) return;
    running = true;
    try {
      tracker.deviceId = sessionStorage.getItem("activityDeviceId") ?? crypto.randomUUID();
      sessionStorage.setItem("activityDeviceId", tracker.deviceId);
    } catch {
      tracker.deviceId = crypto.randomUUID();
    }
    tracker.lastInputPerf = performance.now();

    const onInput = () => {
      tracker.lastInputPerf = performance.now();
      if (tracker.cfg && !tracker.open) evaluate(); // waking from idle starts a fresh interval
    };
    const onVis = () => evaluate();

    window.addEventListener("pointerdown", onInput, { passive: true });
    window.addEventListener("pointermove", onInput, { passive: true });
    window.addEventListener("keydown", onInput);
    window.addEventListener("wheel", onInput, { passive: true });
    window.addEventListener("touchstart", onInput, { passive: true });
    window.addEventListener("focus", onInput);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", beaconFinal);
    const unsubPhone = subscribePhone(evaluate);

    void probe();
    tracker.timers.push(setInterval(evaluate, 5_000));
    tracker.timers.push(setInterval(() => void flush(), 25_000));
    tracker.timers.push(setInterval(() => { if (!tracker.cfg) void probe(); }, 300_000));

    return () => {
      running = false;
      tracker.timers.forEach(clearInterval);
      tracker.timers = [];
      window.removeEventListener("pointerdown", onInput);
      window.removeEventListener("pointermove", onInput);
      window.removeEventListener("keydown", onInput);
      window.removeEventListener("wheel", onInput);
      window.removeEventListener("touchstart", onInput);
      window.removeEventListener("focus", onInput);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", beaconFinal);
      unsubPhone();
    };
  }, []);

  return null;
}
