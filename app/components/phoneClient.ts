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
        if (phoneWanted()) void ensurePhone().catch(() => {});
      }, 5000);
    });
    c.on("telnyx.notification", (n: any) => {
      if (n?.type !== "callUpdate" || !n.call) return;
      const call = n.call;
      const s = call.state;
      if (call.direction === "inbound") {
        if (s === "ringing") {
          state.incoming = { call, from: call.options?.remoteCallerNumber ?? "unknown caller", active: false };
        } else if (s === "active") {
          if (state.incoming) state.incoming = { ...state.incoming, call, active: true };
          state.callPhase = "talking"; // answered inbound = engaged
        } else if (s === "hangup" || s === "destroy") {
          state.incoming = null;
          state.callPhase = "none";
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
