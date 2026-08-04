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

/** Start dual-channel recording on a live call (fired from call.answered). */
export async function startRecording(callControlId: string): Promise<void> {
  await tx(`/calls/${callControlId}/actions/record_start`, {
    method: "POST",
    body: JSON.stringify({ format: "mp3", channels: "dual" }),
  });
}

/** Transcribe a recording URL via Telnyx AI (Whisper). Returns plain text. */
export async function transcribeRecording(mp3Url: string): Promise<string | null> {
  const audio = await fetch(mp3Url);
  if (!audio.ok) throw new Error(`recording download ${audio.status}`);
  const blob = await audio.blob();
  const form = new FormData();
  form.append("file", blob, "call.mp3");
  form.append("model", "distil-whisper/distil-large-v2");
  const res = await fetch(`${API}/ai/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("TELNYX_API_KEY")}` },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`transcription ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json.text ?? null;
}

/** Login token for the browser SDK. Tokens live 24h and Telnyx's mint
 * endpoint is intermittently flaky (5xx) — mint rarely, cache in
 * crm_sync_state, and fall back to the cached token if a refresh fails. */
export async function webrtcToken(db: SupabaseClient, credentialId: string): Promise<string> {
  const { data: cached } = await db.from("crm_sync_state").select("value").eq("key", "telnyx_token").maybeSingle();
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
        .upsert({ key: "telnyx_token", value: { token, mintedAt: Date.now() } }, { onConflict: "key" });
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
