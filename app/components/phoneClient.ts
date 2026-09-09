"use client";

import { reportClientError } from "./ErrorReporter";

/**
 * App-wide softphone singleton. Lives at module scope, so the Telnyx
 * connection survives page navigation — inbound calls ring on any page.
 * The dialer registers an outbound handler for its call state machine; the
 * PhoneDock renders the inbound banner + connection state everywhere.
 */

export interface PhoneIncoming {
  call: any;
  from: string;
  active: boolean;
}

interface PhoneState {
  conn: string; // off | connecting… | ready | reconnecting… | error: …
  incoming: PhoneIncoming | null;
  callerNumber: string | null;
  callPhase: "none" | "dialing" | "talking"; // observed by the activity tracker
}

const state: PhoneState = { conn: "off", incoming: null, callerNumber: null, callPhase: "none" };
let client: any = null;
let readyPromise: Promise<any> | null = null;
let outboundHandler: ((call: any, callState: string) => void) | null = null;
const subs = new Set<() => void>();

// ── Audible ring for inbound calls (classic US dual-tone, 2s on / 4s off).
// AudioContext unlocks on the first user gesture; if the rep has never
// clicked (fresh tab), the browser blocks audio and we ring silently.
let ringCtx: AudioContext | null = null;
let ring: { osc1: OscillatorNode; osc2: OscillatorNode; gain: GainNode; iv: ReturnType<typeof setInterval> } | null = null;

function primeAudio() {
  try {
    ringCtx = ringCtx ?? new AudioContext();
    if (ringCtx.state === "suspended") void ringCtx.resume().catch(() => {});
    // (A constant near-silent keep-alive oscillator lived here briefly to
    // prevent context suspension — audible as a faint tone on some hardware,
    // removed 9/9. Suspension is covered instead by the gesture-blessed
    // <audio> fallback in startRinging.)
  } catch {}
  blessRingElement();
  // Browsers only (WKWebView has no Notification API): ask once, on a real
  // gesture, so OS-level "Incoming call" banners can fire later.
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
  } catch {}
}
if (typeof window !== "undefined") {
  // Persistent, not {once}: WKWebView SUSPENDS idle AudioContexts and refuses
  // to resume them outside a user gesture — so every gesture re-primes. The
  // calls are no-ops while the context is already running.
  window.addEventListener("pointerdown", primeAudio);
  window.addEventListener("keydown", primeAudio);
}

// ── Ring-time attention aids ───────────────────────────────────────────────
// The audible ring only lives in the phone-owner window; these make a call
// noticeable everywhere else: a cross-window broadcast (aux/non-owner windows
// show a banner + ring via their own — likely unlocked — AudioContext), an OS
// notification in browsers, and a flashing tab title. All ring-time only —
// none of this touches live calls.
export const RING_BCAST_KEY = "lpo:ring";
let ringBcastIv: ReturnType<typeof setInterval> | null = null;
function broadcastRing(from: string) {
  const write = () => {
    try {
      localStorage.setItem(RING_BCAST_KEY, JSON.stringify({ at: Date.now(), from }));
    } catch {}
  };
  write();
  if (!ringBcastIv) ringBcastIv = setInterval(write, 3000);
}
function clearRingBroadcast() {
  if (ringBcastIv) {
    clearInterval(ringBcastIv);
    ringBcastIv = null;
  }
  try {
    localStorage.removeItem(RING_BCAST_KEY);
  } catch {}
}

function osNotify(from: string) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const n = new Notification("📞 Incoming call", { body: from, tag: "lpo-incoming", requireInteraction: true });
    n.onclick = () => {
      try {
        window.focus();
        n.close();
      } catch {}
    };
  } catch {}
}

let titleIv: ReturnType<typeof setInterval> | null = null;
let savedTitle: string | null = null;
function startTitleFlash(from: string) {
  if (titleIv || typeof document === "undefined") return;
  savedTitle = document.title;
  let flip = false;
  titleIv = setInterval(() => {
    document.title = flip ? `\u{1F4DE} INCOMING \u2014 ${from}` : "\u260E\uFE0F Incoming call\u2026";
    flip = !flip;
  }, 900);
}
function stopTitleFlash() {
  if (!titleIv) return;
  clearInterval(titleIv);
  titleIv = null;
  if (savedTitle != null && typeof document !== "undefined") document.title = savedTitle;
}

/** Aux/non-owner windows mirror the owner's ring through these. */
export function startRemoteRing() {
  startRinging();
}
export function stopRemoteRing() {
  stopRinging();
  stopTitleFlash();
}
export function flashTitleRemote(from: string) {
  startTitleFlash(from);
}

// Ring patterns — per-machine choice (localStorage "ringtone"), previewable
// from My Profile. "custom" plays an uploaded audio file (data URL).
const RING_PATTERNS: Record<string, { freqs: number[]; steps: [number, number][]; period: number }> = {
  // steps: [offsetSeconds, durationSeconds] bursts within each period
  classic: { freqs: [440, 480], steps: [[0, 2]], period: 6 },
  digital: { freqs: [950, 1400], steps: [[0, 0.15], [0.3, 0.15], [0.6, 0.15], [0.9, 0.15]], period: 2.4 },
  chime: { freqs: [660, 880], steps: [[0, 0.5], [0.8, 0.5]], period: 3.2 },
  pulse: { freqs: [520], steps: [[0, 0.35]], period: 0.8 },
};

export function getRingtoneKind(): string {
  try {
    return localStorage.getItem("ringtone") ?? "classic";
  } catch {
    return "classic";
  }
}

let customAudio: HTMLAudioElement | null = null;

// ── HTMLAudio fallback ring ────────────────────────────────────────────────
// When the AudioContext is suspended and a non-gesture resume() is refused
// (Logan 9/8: ringtone PREVIEW audible — click context — but real rings
// silent), oscillators run against a frozen clock and produce nothing.
// <audio> elements are exempt once autoplay is allowed (call audio itself
// proves this works gesture-free in the companion), so we synthesize the ring
// pattern as a WAV data-URI and loop it.
// Gesture-blessing: WKWebView refuses .play() on a FRESH media element
// outside a user gesture, but remembers permission per-element once it has
// played inside one. So on every gesture we (cheaply, once per src) play the
// ring element muted and immediately pause it; at ring time, .play() on the
// blessed element is allowed even with no gesture in sight.
let fallbackAudio: HTMLAudioElement | null = null;
let blessedSrc: string | null = null;
function ringSrc(): string {
  const kind = getRingtoneKind();
  if (kind === "custom") {
    try {
      const data = localStorage.getItem("ringtoneData");
      if (data) return data;
    } catch {}
  }
  return ringWavUri(kind === "custom" ? "classic" : kind);
}
function blessRingElement() {
  try {
    const src = ringSrc();
    if (blessedSrc === src) return;
    const el = fallbackAudio ?? new Audio();
    fallbackAudio = el;
    el.src = src;
    el.loop = true;
    el.muted = true;
    void el
      .play()
      .then(() => {
        el.pause();
        el.currentTime = 0;
        el.muted = false;
        blessedSrc = src;
      })
      .catch(() => {
        el.muted = false;
      });
  } catch {}
}
const ringWavCache = new Map<string, string>();
function ringWavUri(kind: string): string {
  const hit = ringWavCache.get(kind);
  if (hit) return hit;
  const pattern = RING_PATTERNS[kind] ?? RING_PATTERNS.classic;
  const rate = 8000;
  const len = Math.round(pattern.period * rate);
  const pcm = new Uint8Array(len).fill(128); // 8-bit unsigned silence
  for (const [off, dur] of pattern.steps) {
    const start = Math.round(off * rate);
    const end = Math.min(len, Math.round((off + dur) * rate));
    for (let i = start; i < end; i++) {
      let v = 0;
      for (const f of pattern.freqs) v += Math.sin((2 * Math.PI * f * i) / rate);
      pcm[i] = 128 + Math.round((v / pattern.freqs.length) * 90);
    }
  }
  const bytes = new Uint8Array(44 + len);
  const dv = new DataView(bytes.buffer);
  const wstr = (o: number, str: string) => {
    for (let i = 0; i < str.length; i++) bytes[o + i] = str.charCodeAt(i);
  };
  wstr(0, "RIFF");
  dv.setUint32(4, 36 + len, true);
  wstr(8, "WAVEfmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate, true); // byte rate (8-bit mono)
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  wstr(36, "data");
  dv.setUint32(40, len, true);
  bytes.set(pcm, 44);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const uri = `data:audio/wav;base64,${btoa(bin)}`;
  ringWavCache.set(kind, uri);
  return uri;
}

function startFallbackRing() {
  try {
    if (!fallbackAudio) {
      // No gesture has ever blessed an element — try cold anyway (works in
      // browsers where autoplay is permitted).
      fallbackAudio = new Audio(ringSrc());
      fallbackAudio.loop = true;
    }
    fallbackAudio.volume = 0.7;
    fallbackAudio.currentTime = 0;
    void fallbackAudio.play().catch((e) => ringDiag("fallback-err", { err: String(e).slice(0, 120) }));
  } catch (e) {
    ringDiag("fallback-throw", { err: String(e).slice(0, 120) });
  }
}

/** Ring telemetry → client_errors (kind "ring-diag"): shows per machine
 * whether a ring attempt ran, the audio-context state, and whether the
 * fallback fired — instead of remote guessing (Logan's silent ring). */
function ringDiag(stage: string, extra: Record<string, unknown>) {
  try {
    reportClientError("ring-diag", `${stage} ${JSON.stringify(extra)} @${new Date().toISOString().slice(11, 19)}`);
  } catch {}
}

function startRinging(kindOverride?: string) {
  if (ring || customAudio) return;
  if (fallbackAudio && !fallbackAudio.paused) return;
  const kind = kindOverride ?? getRingtoneKind();
  if (!kindOverride) {
    ringDiag("start", { kind, ctx: ringCtx?.state ?? "none", blessed: !!blessedSrc });
    // REAL rings go media-element FIRST: AVFoundation-backed playback follows
    // the CURRENT default output device, while a WebAudio context stays
    // pinned to the device that was default at creation — Logan 9/9: ctx
    // "running", blessed, and still silent after an audio factory-reset,
    // yet the element-driven preview was audible. Oscillators remain the
    // backup (and the preview path).
    try {
      if (!fallbackAudio) {
        fallbackAudio = new Audio(ringSrc());
        fallbackAudio.loop = true;
      }
      fallbackAudio.volume = 0.7;
      fallbackAudio.currentTime = 0;
      void fallbackAudio
        .play()
        .then(() => ringDiag("element-ok", {}))
        .catch((e) => {
          ringDiag("element-err", { err: String(e).slice(0, 120) });
          startOscRing(kind, false);
        });
      return;
    } catch (e) {
      ringDiag("element-throw", { err: String(e).slice(0, 120) });
      // fall through to oscillators
    }
  }
  startOscRing(kind, !!kindOverride);
}

function startOscRing(kind: string, isPreview: boolean) {
  if (ring || customAudio) return;
  try {
    if (kind === "custom") {
      let data: string | null = null;
      try {
        data = localStorage.getItem("ringtoneData");
      } catch {}
      if (data) {
        customAudio = new Audio(data);
        customAudio.loop = true;
        customAudio.volume = 0.6;
        void customAudio.play().catch(() => {
          customAudio = null;
          startOscRing("classic", isPreview); // custom blocked/broken → default tone
        });
        return;
      }
      // no file saved — fall through to classic
    }
    primeAudio();
    if (!ringCtx) return;
    const pattern = RING_PATTERNS[kind] ?? RING_PATTERNS.classic;
    const gain = ringCtx.createGain();
    gain.gain.value = 0;
    gain.connect(ringCtx.destination);
    const oscs = pattern.freqs.map((f) => {
      const o = ringCtx!.createOscillator();
      o.frequency.value = f;
      o.connect(gain);
      o.start();
      return o;
    });
    const burst = () => {
      if (!ringCtx) return;
      const t = ringCtx.currentTime;
      gain.gain.cancelScheduledValues(t);
      for (const [off, dur] of pattern.steps) {
        gain.gain.setValueAtTime(0.25, t + off);
        gain.gain.setValueAtTime(0, t + off + dur);
      }
    };
    ring = { osc1: oscs[0], osc2: oscs[1] ?? oscs[0], gain, iv: setInterval(burst, pattern.period * 1000) };
    burst();
    // Give resume() a beat; if the context still isn't running the
    // oscillators are silent — ring via <audio> instead.
    setTimeout(() => {
      if (!isPreview && ring && ringCtx && ringCtx.state !== "running") {
        ringDiag("fallback", { ctx: ringCtx.state });
        startFallbackRing();
      }
    }, 350);
  } catch {}
}

function stopRinging() {
  if (customAudio) {
    try {
      customAudio.pause();
    } catch {}
    customAudio = null;
  }
  if (fallbackAudio) {
    try {
      fallbackAudio.pause();
      fallbackAudio.currentTime = 0;
    } catch {}
  }
  if (!ring) return;
  clearInterval(ring.iv);
  try {
    ring.osc1.stop();
    if (ring.osc2 !== ring.osc1) ring.osc2.stop();
    ring.gain.disconnect();
  } catch {}
  ring = null;
}

/** Silence the current ring WITHOUT touching the call (Ignore button). */
export function silenceRing() {
  stopRinging();
  clearRingBroadcast();
  stopTitleFlash();
}

/** Short preview for the ringtone picker. */
export function previewRingtone(kind: string) {
  stopRinging();
  startRinging(kind);
  setTimeout(stopRinging, 2600);
}

const emit = () => subs.forEach((f) => f());

export function subscribePhone(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getPhoneState(): PhoneState {
  return { ...state };
}

export function setOutboundHandler(h: ((call: any, callState: string) => void) | null) {
  outboundHandler = h;
}

/**
 * Aux windows (?aux=1, sticky per-window via sessionStorage) NEVER register
 * the softphone — one SIP registration per rep, owned by the main window.
 * Two live registrations of the same credential double-ring and race answers.
 */
export function isAuxWindow(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).has("aux")) {
      sessionStorage.setItem("lpoAux", "1");
      return true;
    }
    return sessionStorage.getItem("lpoAux") === "1";
  } catch {
    return false;
  }
}

export function phoneWanted(): boolean {
  try {
    return localStorage.getItem("dialMethod") === "browser";
  } catch {
    return false;
  }
}

/**
 * The phone must ALSO stay registered when this rep receives inbound on a
 * Telnyx number — even if their outbound preference is Quo. Otherwise the
 * inbound transfer leg gets rejected as unreachable (user_busy) and callers
 * fall straight to voicemail. Cached 30 min per tab.
 */
export async function phoneRequired(): Promise<boolean> {
  if (isAuxWindow()) return false;
  if (phoneWanted()) return true;
  try {
    const cached = sessionStorage.getItem("telnyxInbound");
    if (cached) {
      const { v, at } = JSON.parse(cached);
      if (Date.now() - at < 30 * 60_000) return Boolean(v);
    }
  } catch {}
  try {
    const r = await fetch("/api/me/phone");
    if (!r.ok) return false;
    const d = await r.json();
    try {
      sessionStorage.setItem("telnyxInbound", JSON.stringify({ v: Boolean(d.telnyxInbound), at: Date.now() }));
    } catch {}
    return Boolean(d.telnyxInbound);
  } catch {
    return false;
  }
}

// ── Single-registration guard ───────────────────────────────────────────────
// Post-port every window of a rep shares ONE SIP login; two live
// registrations flap forever (Telnyx kicks the older one, it reconnects,
// kicks the newer…). Exactly one window per browser owns the phone —
// localStorage lock with a heartbeat, PageLock-style. A window that loses
// the race watches for the owner to go away and takes over.
const PHONE_TAB_ID = Math.random().toString(36).slice(2);
const OWNER_KEY = "lpo:phone-owner";
let ownerHeartbeat: ReturnType<typeof setInterval> | null = null;
let ownerWatch: ReturnType<typeof setInterval> | null = null;
function phoneOwnedElsewhere(): boolean {
  try {
    const rec = JSON.parse(localStorage.getItem(OWNER_KEY) ?? "null");
    return Boolean(rec && rec.id !== PHONE_TAB_ID && Date.now() - rec.at < 10_000);
  } catch {
    return false;
  }
}
function claimPhoneOwner() {
  try {
    localStorage.setItem(OWNER_KEY, JSON.stringify({ id: PHONE_TAB_ID, at: Date.now() }));
  } catch {}
}
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    try {
      const rec = JSON.parse(localStorage.getItem(OWNER_KEY) ?? "null");
      if (rec?.id === PHONE_TAB_ID) localStorage.removeItem(OWNER_KEY);
    } catch {}
  });
}
// Reconnect backoff: 5s doubling to 60s; reset on a successful registration.
let reconnectFails = 0;

export async function ensurePhone(): Promise<any> {
  if (isAuxWindow()) throw new Error("Phone lives in your main window — dial from there");
  if (phoneOwnedElsewhere()) {
    state.conn = "phone active in another window";
    emit();
    // Watch for the owning window to close, then take over.
    ownerWatch ??= setInterval(() => {
      if (!phoneOwnedElsewhere()) {
        if (ownerWatch) clearInterval(ownerWatch);
        ownerWatch = null;
        void phoneRequired().then((w) => w && ensurePhone().catch(() => {}));
      }
    }, 8000);
    throw new Error("Phone is active in another window — dial from there");
  }
  claimPhoneOwner();
  ownerHeartbeat ??= setInterval(claimPhoneOwner, 4000);
  if (readyPromise) return readyPromise;
  state.conn = "connecting…";
  emit();
  readyPromise = (async () => {
    const r = await fetch("/api/telnyx/token");
    if (!r.ok) {
      const d = await r.json().catch(() => null);
      throw new Error(d?.error ?? (r.status === 503 ? "Telnyx not configured yet" : `HTTP ${r.status}`));
    }
    const { token, login, password, callerNumber } = await r.json();
    state.callerNumber = callerNumber ?? null;
    const { TelnyxRTC } = await import("@telnyx/webrtc");
    // Tear down any previous instance FIRST — a replaced client keeps its own
    // internal reconnect machinery alive and zombie instances accumulate
    // until the webview drowns (8/27: near-unresponsive companions after
    // hours of socket flapping).
    if (client) {
      try {
        client.disconnect();
      } catch {}
      client = null;
    }
    // SIP login (per-rep, receives inbound) when provisioned; token otherwise.
    const c = login ? new TelnyxRTC({ login, password }) : new TelnyxRTC({ login_token: token });
    client = c;
    c.remoteElement = "telnyx-audio";
    c.on("telnyx.error", (e: any) => {
      if (client !== c) return; // stale instance — its events are noise
      console.error("telnyx error", e);
      state.conn = `error: ${e?.message ?? "unknown"}`;
      emit();
    });
    c.on("telnyx.socket.close", () => {
      // A superseded instance closing must NOT trigger another reconnect —
      // that's the zombie multiplication path. Fully kill it and bail.
      if (client !== c) {
        try {
          c.disconnect();
        } catch {}
        return;
      }
      try {
        c.disconnect();
      } catch {}
      state.conn = "reconnecting…";
      readyPromise = null;
      client = null;
      emit();
      const delay = Math.min(5000 * 2 ** Math.min(reconnectFails++, 4), 60_000);
      setTimeout(() => {
        void phoneRequired().then((w) => w && ensurePhone().catch(() => {}));
      }, delay);
    });
    let outboundLive = false; // an outbound call the rep is actively on
    c.on("telnyx.notification", (n: any) => {
      // Superseded instances still receive events until fully dead — without
      // this guard their INVITE/cancel cycles fired short phantom ring
      // bursts through the shared audio path ("3 beeps every few minutes",
      // Cainen 9/9). Same guard as error/socket.close.
      if (client !== c) return;
      if (n?.type !== "callUpdate" || !n.call) return;
      const call = n.call;
      const s = call.state;
      if (call.direction === "inbound") {
        if (s === "ringing") {
          const from = call.options?.remoteCallerNumber ?? "unknown caller";
          state.incoming = { call, from, active: false };
          startRinging();
          broadcastRing(from);
          osNotify(from);
          startTitleFlash(from);
          // Companion: surface the app when a call rings while minimized/behind.
          const tauri = (window as any).__TAURI__;
          if (tauri?.core?.invoke) void tauri.core.invoke("focus_main").catch(() => {});
          else if (typeof window !== "undefined") window.focus(); // browsers: best-effort
        } else if (s === "active") {
          if (state.incoming) state.incoming = { ...state.incoming, call, active: true };
          state.callPhase = "talking"; // answered inbound = engaged
          stopRinging();
          clearRingBroadcast();
          stopTitleFlash();
        } else if (s === "hangup" || s === "destroy") {
          state.incoming = null;
          // An inbound leg dying must NOT reset the phase while an outbound
          // call is live (a busy-rep ring being cancelled looked like the
          // active call ending and corrupted call-phase consumers).
          state.callPhase = outboundLive ? "talking" : "none";
          stopRinging();
          clearRingBroadcast();
          stopTitleFlash();
        }
        emit();
        return;
      }
      // Outbound phase for the activity tracker (a ringing inbound the rep
      // hasn't answered is NOT engagement, so only outbound counts as dialing).
      if (s === "active") {
        state.callPhase = "talking";
        outboundLive = true;
      } else if (s === "hangup" || s === "destroy") {
        state.callPhase = "none";
        outboundLive = false;
      } else state.callPhase = "dialing"; // new/requesting/trying/early/ringing
      emit();
      outboundHandler?.(call, s);
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Telnyx connection timed out")), 15_000);
      c.on("telnyx.ready", () => {
        clearTimeout(t);
        reconnectFails = 0;
        state.conn = "ready";
        emit();
        resolve();
      });
      c.connect();
    });
    return c;
  })();
  readyPromise.catch((e) => {
    state.conn = `error: ${e instanceof Error ? e.message : String(e)}`;
    readyPromise = null;
    client = null;
    emit();
  });
  return readyPromise;
}

export async function newOutboundCall(phone: string): Promise<any> {
  const c = await ensurePhone();
  state.callPhase = "dialing"; // count call setup from the click, not the first event
  emit();
  return c.newCall({
    destinationNumber: phone,
    callerNumber: state.callerNumber ?? undefined,
    audio: true,
    video: false,
  });
}

export function answerIncoming() {
  try {
    state.incoming?.call.answer();
  } catch (e) {
    console.error("answer failed", e);
  }
}

export function endIncoming() {
  try {
    state.incoming?.call.hangup();
  } catch {}
  state.incoming = null;
  emit();
}
