"use client";

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
  } catch {}
}
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", primeAudio, { once: true });
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

function startRinging(kindOverride?: string) {
  if (ring || customAudio) return;
  const kind = kindOverride ?? getRingtoneKind();
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
          startRinging("classic"); // custom blocked/broken → default tone
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
        gain.gain.setValueAtTime(0.15, t + off);
        gain.gain.setValueAtTime(0, t + off + dur);
      }
    };
    ring = { osc1: oscs[0], osc2: oscs[1] ?? oscs[0], gain, iv: setInterval(burst, pattern.period * 1000) };
    burst();
  } catch {}
}

function stopRinging() {
  if (customAudio) {
    try {
      customAudio.pause();
    } catch {}
    customAudio = null;
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

export async function ensurePhone(): Promise<any> {
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
    // SIP login (per-rep, receives inbound) when provisioned; token otherwise.
    const c = login ? new TelnyxRTC({ login, password }) : new TelnyxRTC({ login_token: token });
    client = c;
    c.remoteElement = "telnyx-audio";
    c.on("telnyx.error", (e: any) => {
      console.error("telnyx error", e);
      state.conn = `error: ${e?.message ?? "unknown"}`;
      emit();
    });
    c.on("telnyx.socket.close", () => {
      state.conn = "reconnecting…";
      readyPromise = null;
      client = null;
      emit();
      setTimeout(() => {
        void phoneRequired().then((w) => w && ensurePhone().catch(() => {}));
      }, 5000);
    });
    c.on("telnyx.notification", (n: any) => {
      if (n?.type !== "callUpdate" || !n.call) return;
      const call = n.call;
      const s = call.state;
      if (call.direction === "inbound") {
        if (s === "ringing") {
          state.incoming = { call, from: call.options?.remoteCallerNumber ?? "unknown caller", active: false };
          startRinging();
        } else if (s === "active") {
          if (state.incoming) state.incoming = { ...state.incoming, call, active: true };
          state.callPhase = "talking"; // answered inbound = engaged
          stopRinging();
        } else if (s === "hangup" || s === "destroy") {
          state.incoming = null;
          state.callPhase = "none";
          stopRinging();
        }
        emit();
        return;
      }
      // Outbound phase for the activity tracker (a ringing inbound the rep
      // hasn't answered is NOT engagement, so only outbound counts as dialing).
      if (s === "active") state.callPhase = "talking";
      else if (s === "hangup" || s === "destroy") state.callPhase = "none";
      else state.callPhase = "dialing"; // new/requesting/trying/early/ringing
      emit();
      outboundHandler?.(call, s);
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Telnyx connection timed out")), 15_000);
      c.on("telnyx.ready", () => {
        clearTimeout(t);
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
