import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env, envOptional } from "./env";

/**
 * Telnyx MVP: browser calling via WebRTC. Provisioning is idempotent and
 * API-driven — a credential connection ("lpo-webrtc"), an outbound voice
 * profile, and whatever number exists on the account. State (credential id,
 * caller number) is cached in crm_sync_state "telnyx".
 */

const API = "https://api.telnyx.com/v2";

export function telnyxConfigured(): boolean {
  return Boolean(envOptional("TELNYX_API_KEY"));
}

/**
 * Send an SMS/MMS via Telnyx. The `from` number's messaging profile handles
 * routing; TELNYX_MESSAGING_PROFILE_ID is passed when set (belt + suspenders).
 * Returns the Telnyx message id + the recipient's initial status.
 */
export async function sendSms(opts: {
  from: string;
  to: string;
  text: string;
  mediaUrls?: string[];
}): Promise<{ id: string; status: string; from: string; sentAt: string }> {
  const payload: Record<string, unknown> = { from: opts.from, to: opts.to, text: opts.text };
  if (opts.mediaUrls?.length) payload.media_urls = opts.mediaUrls;
  const profile = envOptional("TELNYX_MESSAGING_PROFILE_ID");
  if (profile) payload.messaging_profile_id = profile;
  const json = await tx("/messages", { method: "POST", body: JSON.stringify(payload) });
  const d = json.data ?? {};
  return {
    id: d.id,
    status: d.to?.[0]?.status ?? "queued",
    from: d.from?.phone_number ?? opts.from,
    sentAt: d.sent_at ?? d.received_at ?? new Date().toISOString(),
  };
}

async function tx(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env("TELNYX_API_KEY")}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`telnyx ${path} ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
  }
  return json;
}

export interface TelnyxState {
  connectionId: string;
  credentialId: string;
  callerNumber: string | null;
}

/** Find-or-create everything the browser dialer needs. Safe to re-run. */
export async function ensureProvisioned(db: SupabaseClient): Promise<TelnyxState> {
  const { data: cached } = await db.from("crm_sync_state").select("value").eq("key", "telnyx").maybeSingle();
  const val = cached?.value as TelnyxState | undefined;
  if (val?.credentialId && val?.callerNumber) return val;

  // 1. Credential connection for WebRTC.
  const conns = await tx("/credential_connections?filter[connection_name][contains]=lpo-webrtc");
  let conn = (conns.data ?? [])[0];
  if (!conn) {
    const created = await tx("/credential_connections", {
      method: "POST",
      body: JSON.stringify({
        connection_name: "lpo-webrtc",
        user_name: `lpo${Math.random().toString(36).slice(2, 10)}`,
        password: crypto.randomUUID().replace(/-/g, ""),
        webhook_event_url: "https://lpo-sales-engine.vercel.app/api/webhooks/telnyx",
      }),
    });
    conn = created.data;
  }

  // 2. Outbound voice profile, attached to the connection.
  const ovps = await tx("/outbound_voice_profiles?filter[name][contains]=lpo-outbound");
  let ovp = (ovps.data ?? [])[0];
  if (!ovp) {
    const created = await tx("/outbound_voice_profiles", {
      method: "POST",
      body: JSON.stringify({
        name: "lpo-outbound",
        traffic_type: "conversational",
        service_plan: "global",
        usage_payment_method: "rate-deck",
      }),
    });
    ovp = created.data;
  }
  await tx(`/credential_connections/${conn.id}`, {
    method: "PATCH",
    body: JSON.stringify({ outbound: { outbound_voice_profile_id: ovp.id } }),
  }).catch(() => {});

  // 3. On-demand credential for token minting.
  const creds = await tx(`/telephony_credentials?filter[name]=lpo-dialer`);
  let cred = (creds.data ?? [])[0];
  if (!cred) {
    const created = await tx("/telephony_credentials", {
      method: "POST",
      body: JSON.stringify({ name: "lpo-dialer", connection_id: conn.id }),
    });
    cred = created.data;
  }

  // 4. Caller number: first number on the account (trial or purchased).
  const numbers = await tx("/phone_numbers?page[size]=5");
  const callerNumber = (numbers.data ?? [])[0]?.phone_number ?? null;

  const state: TelnyxState = { connectionId: conn.id, credentialId: cred.id, callerNumber };
  await db.from("crm_sync_state").upsert({ key: "telnyx", value: state }, { onConflict: "key" });
  return state;
}

/**
 * Per-rep calling identity: own credential connection + credential, with the
 * rep's number pointed at it — inbound rings only that rep's browser.
 * Idempotent; called when a number is assigned in Settings.
 */
export async function provisionRepCalling(
  db: SupabaseClient,
  rep: { id: string; telnyx_connection_id: string | null; telnyx_credential_id: string | null },
  phoneNumber: string
): Promise<void> {
  const slug = `lpo-rep-${rep.id.slice(0, 8)}`;
  let connectionId = rep.telnyx_connection_id;
  if (!connectionId) {
    const existing = await tx(`/credential_connections?filter[connection_name][contains]=${slug}`);
    let conn = (existing.data ?? [])[0];
    if (!conn) {
      const userName = `${slug.replace(/-/g, "")}${Math.random().toString(36).slice(2, 6)}`;
      const password = crypto.randomUUID().replace(/-/g, "");
      const created = await tx("/credential_connections", {
        method: "POST",
        body: JSON.stringify({
          connection_name: slug,
          user_name: userName,
          password,
          webhook_event_url: "https://lpo-sales-engine.vercel.app/api/webhooks/telnyx",
        }),
      });
      conn = created.data;
      // The connection's own SIP login is what registers for INBOUND —
      // token-credential registration proved not to bind to the connection.
      await db
        .from("crm_sync_state")
        .upsert(
          { key: `telnyx_sip:${rep.id}`, value: { login: userName, password } },
          { onConflict: "key" }
        );
    }
    connectionId = conn.id;
    // Same outbound voice profile as the shared connection.
    const ovps = await tx("/outbound_voice_profiles?filter[name][contains]=lpo-outbound");
    const ovp = (ovps.data ?? [])[0];
    if (ovp) {
      await tx(`/credential_connections/${connectionId}`, {
        method: "PATCH",
        body: JSON.stringify({ outbound: { outbound_voice_profile_id: ovp.id } }),
      }).catch(() => {});
    }
  }

  let credentialId = rep.telnyx_credential_id;
  if (!credentialId) {
    const creds = await tx(`/telephony_credentials?filter[name]=${slug}`);
    let cred = (creds.data ?? [])[0];
    if (!cred) {
      const created = await tx("/telephony_credentials", {
        method: "POST",
        body: JSON.stringify({ name: slug, connection_id: connectionId }),
      });
      cred = created.data;
    }
    credentialId = cred.id;
  }

  // Numbers route inbound through the CALL CONTROL app (voicemail-capable);
  // the webhook transfers to this rep's SIP client. Fall back to the rep's
  // connection only if the app can't be ensured.
  let inboundTarget = connectionId;
  try {
    const { inboundAppId } = await ensureInboundApp(db);
    inboundTarget = inboundAppId;
  } catch (e) {
    console.error("ensureInboundApp failed — number stays on rep connection", e);
  }
  const nums = await tx(`/phone_numbers?filter[phone_number]=${encodeURIComponent(phoneNumber)}`);
  const num = (nums.data ?? [])[0];
  if (num && String(num.connection_id) !== String(inboundTarget)) {
    await tx(`/phone_numbers/${num.id}`, {
      method: "PATCH",
      body: JSON.stringify({ connection_id: inboundTarget }),
    });
  }

  await db
    .from("reps")
    .update({ telnyx_connection_id: connectionId, telnyx_credential_id: credentialId })
    .eq("id", rep.id);
}

/** Start dual-channel recording on a live call (fired from call.answered). */
export async function startRecording(
  callControlId: string,
  opts?: { beep?: boolean; clientState?: string }
): Promise<void> {
  await tx(`/calls/${callControlId}/actions/record_start`, {
    method: "POST",
    body: JSON.stringify({
      format: "mp3",
      channels: "dual",
      ...(opts?.beep ? { play_beep: true } : {}),
      ...(opts?.clientState ? { client_state: Buffer.from(opts.clientState).toString("base64") } : {}),
    }),
  });
}

// ── Voicemail (Call Control on the inbound PSTN leg) ────────────────────────

/** Answer an unanswered inbound leg (takes the call over from the ringing client). */
export async function answerCall(callControlId: string, clientState: string): Promise<void> {
  await tx(`/calls/${callControlId}/actions/answer`, {
    method: "POST",
    body: JSON.stringify({ client_state: Buffer.from(clientState).toString("base64") }),
  });
}

/** Speak text into the call (TTS) — used for the voicemail greeting. */
export async function speakCall(callControlId: string, text: string, clientState: string): Promise<void> {
  await tx(`/calls/${callControlId}/actions/speak`, {
    method: "POST",
    body: JSON.stringify({
      payload: text,
      voice: "female",
      language: "en-US",
      client_state: Buffer.from(clientState).toString("base64"),
    }),
  });
}

/** Ring a SIP client (the rep's browser) by transferring the unanswered
 * inbound leg — Telnyx dials the target and bridges on answer. timeout_secs
 * is set LONGER than the voicemail window so our timer wins the race. */
export async function transferCall(
  callControlId: string,
  to: string,
  opts: { timeoutSecs: number; clientState: string }
): Promise<void> {
  await tx(`/calls/${callControlId}/actions/transfer`, {
    method: "POST",
    body: JSON.stringify({
      to,
      timeout_secs: opts.timeoutSecs,
      client_state: Buffer.from(opts.clientState).toString("base64"),
    }),
  });
}

/**
 * Inbound numbers must live on a CALL CONTROL application — credential
 * connections ring the browser directly but refuse API answer/speak/record,
 * which voicemail needs. Find-or-create the app (cached in crm_sync_state
 * "telnyx" as inboundAppId) and point every rep-assigned number at it; the
 * webhook then transfers inbound calls to the owning rep's SIP client.
 */
export async function ensureInboundApp(db: SupabaseClient): Promise<{ inboundAppId: string; moved: string[] }> {
  const { data: cached } = await db.from("crm_sync_state").select("value").eq("key", "telnyx").maybeSingle();
  const state = ((cached?.value as any) ?? {}) as Record<string, unknown>;

  let appId = state.inboundAppId as string | undefined;
  if (!appId) {
    const apps = await tx("/call_control_applications?filter[application_name][contains]=lpo-inbound");
    let app = (apps.data ?? [])[0];
    if (!app) {
      const created = await tx("/call_control_applications", {
        method: "POST",
        body: JSON.stringify({
          application_name: "lpo-inbound",
          webhook_event_url: "https://lpo-sales-engine.vercel.app/api/webhooks/telnyx",
        }),
      });
      app = created.data;
    }
    appId = app.id as string;
    await db
      .from("crm_sync_state")
      .upsert({ key: "telnyx", value: { ...state, inboundAppId: appId } }, { onConflict: "key" });
  }

  // The transfer's outbound leg (app → rep's SIP client) needs an outbound
  // voice profile on the application, same as any outbound-capable connection.
  try {
    const ovps = await tx("/outbound_voice_profiles?filter[name][contains]=lpo-outbound");
    const ovp = (ovps.data ?? [])[0];
    if (ovp) {
      await tx(`/call_control_applications/${appId}`, {
        method: "PATCH",
        body: JSON.stringify({
          application_name: "lpo-inbound",
          webhook_event_url: "https://lpo-sales-engine.vercel.app/api/webhooks/telnyx",
          outbound: { outbound_voice_profile_id: ovp.id },
        }),
      });
    }
  } catch (e) {
    console.error("inbound app OVP attach failed", e);
  }

  // Point every assigned number (reps + the account default) at the app.
  const targets = new Set<string>();
  const { data: reps } = await db.from("reps").select("telnyx_number").not("telnyx_number", "is", null);
  for (const r of reps ?? []) if (r.telnyx_number) targets.add(r.telnyx_number);
  if (state.callerNumber) targets.add(state.callerNumber as string);

  const moved: string[] = [];
  for (const num of targets) {
    try {
      const found = await tx(`/phone_numbers?filter[phone_number]=${encodeURIComponent(num)}`);
      const rec = (found.data ?? [])[0];
      if (rec && String(rec.connection_id) !== String(appId)) {
        await tx(`/phone_numbers/${rec.id}`, {
          method: "PATCH",
          body: JSON.stringify({ connection_id: appId }),
        });
        moved.push(num);
      }
    } catch (e) {
      console.error(`inbound-app number move failed for ${num}`, e);
    }
  }
  return { inboundAppId: appId, moved };
}

/** Put numbers BACK on their rep credential connections (the known-good
 * direct-ring path) — used to restore inbound while the Call Control
 * transfer flow is debugged. */
export async function revertInboundNumbers(db: SupabaseClient): Promise<{ moved: string[] }> {
  const moved: string[] = [];
  const { data: reps } = await db
    .from("reps")
    .select("telnyx_number, telnyx_connection_id")
    .not("telnyx_number", "is", null);
  for (const r of reps ?? []) {
    if (!r.telnyx_number || !r.telnyx_connection_id) continue;
    try {
      const found = await tx(`/phone_numbers?filter[phone_number]=${encodeURIComponent(r.telnyx_number)}`);
      const rec = (found.data ?? [])[0];
      if (rec && String(rec.connection_id) !== String(r.telnyx_connection_id)) {
        await tx(`/phone_numbers/${rec.id}`, {
          method: "PATCH",
          body: JSON.stringify({ connection_id: r.telnyx_connection_id }),
        });
        moved.push(r.telnyx_number);
      }
    } catch (e) {
      console.error(`revert failed for ${r.telnyx_number}`, e);
    }
  }
  return { moved };
}

/** SIP username of the shared token credential ("lpo-dialer") — where
 * token-authenticated clients (sessions without a per-rep SIP login, e.g.
 * the kyle@ admin account) register. Cached in crm_sync_state.telnyx. */
export async function getSharedSipUsername(db: SupabaseClient): Promise<string | null> {
  const { data } = await db.from("crm_sync_state").select("value").eq("key", "telnyx").maybeSingle();
  const state = ((data?.value as any) ?? {}) as Record<string, unknown>;
  if (state.sharedSipUsername) return state.sharedSipUsername as string;
  if (!state.credentialId) return null;
  try {
    const cred = await tx(`/telephony_credentials/${state.credentialId}`);
    const u = cred.data?.sip_username ?? null;
    if (u) {
      await db
        .from("crm_sync_state")
        .upsert({ key: "telnyx", value: { ...state, sharedSipUsername: u } }, { onConflict: "key" });
    }
    return u;
  } catch (e) {
    console.error("shared sip lookup failed", e);
    return null;
  }
}

/** Play an audio file into the call (recorded voicemail greeting). */
export async function playbackCall(callControlId: string, audioUrl: string, clientState: string): Promise<void> {
  await tx(`/calls/${callControlId}/actions/playback_start`, {
    method: "POST",
    body: JSON.stringify({
      audio_url: audioUrl,
      client_state: Buffer.from(clientState).toString("base64"),
    }),
  });
}

/** Decode the client_state a webhook event echoes back (base64 → string). */
export function decodeClientState(cs: unknown): string | null {
  if (typeof cs !== "string" || !cs) return null;
  try {
    return Buffer.from(cs, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export interface TranscriptResult {
  text: string;
  // Speaker-attributed turns (dual-channel: 0 = rep leg, 1 = customer leg).
  utterances: Array<{ speaker: "rep" | "contact"; text: string }> | null;
}

/**
 * Transcribe a recording. Deepgram (multichannel — perfect speaker labels
 * from the dual-channel recording) when DEEPGRAM_API_KEY is set; Telnyx AI
 * Whisper (plain text) otherwise.
 */
export async function transcribeRecording(mp3Url: string): Promise<TranscriptResult | null> {
  const audio = await fetch(mp3Url);
  if (!audio.ok) throw new Error(`recording download ${audio.status}`);

  const dgKey = envOptional("DEEPGRAM_API_KEY");
  if (dgKey) {
    const res = await fetch(
      "https://api.deepgram.com/v1/listen?model=nova-2&multichannel=true&punctuate=true&smart_format=true&utterances=true",
      {
        method: "POST",
        headers: { Authorization: `Token ${dgKey}`, "Content-Type": "audio/mpeg" },
        body: await audio.arrayBuffer(),
      }
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`deepgram ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    const utts = (json.results?.utterances ?? [])
      .map((u: any) => ({
        speaker: (u.channel === 0 ? "rep" : "contact") as "rep" | "contact",
        text: String(u.transcript ?? "").trim(),
        start: u.start ?? 0,
      }))
      .filter((u: any) => u.text)
      .sort((a: any, b: any) => a.start - b.start);
    if (utts.length === 0) return null;
    const text = utts
      .map((u: any) => `${u.speaker === "rep" ? "Rep" : "Customer"}: ${u.text}`)
      .join("\n");
    return { text, utterances: utts.map(({ speaker, text }: any) => ({ speaker, text })) };
  }

  const form = new FormData();
  form.append("file", await audio.blob(), "call.mp3");
  form.append("model", "distil-whisper/distil-large-v2");
  const res = await fetch(`${API}/ai/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("TELNYX_API_KEY")}` },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`transcription ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json.text ? { text: json.text, utterances: null } : null;
}

/** Login token for the browser SDK. Tokens live 24h and Telnyx's mint
 * endpoint is intermittently flaky (5xx) — mint rarely, cache in
 * crm_sync_state, and fall back to the cached token if a refresh fails. */
export async function webrtcToken(db: SupabaseClient, credentialId: string): Promise<string> {
  const cacheKey = `telnyx_token:${credentialId}`;
  const { data: cached } = await db.from("crm_sync_state").select("value").eq("key", cacheKey).maybeSingle();
  const val = cached?.value as { token?: string; mintedAt?: number } | undefined;
  const ageMs = val?.mintedAt ? Date.now() - val.mintedAt : Infinity;
  if (val?.token && ageMs < 20 * 3600_000) return val.token; // reuse for 20h

  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}/telephony_credentials/${credentialId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env("TELNYX_API_KEY")}` },
    });
    if (res.ok) {
      const token = await res.text();
      await db
        .from("crm_sync_state")
        .upsert({ key: cacheKey, value: { token, mintedAt: Date.now() } }, { onConflict: "key" });
      return token;
    }
    lastErr = `telnyx token ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (res.status < 500) break; // 4xx won't heal on retry
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  // Mint failed — a stale-but-unexpired cached token beats an error.
  if (val?.token && ageMs < 23 * 3600_000) return val.token;
  throw new Error(lastErr);
}
