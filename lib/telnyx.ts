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
      body: JSON.stringify({ name: "lpo-outbound", traffic_type: "conversational", service_plan: "us" }),
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

/** Short-lived token the browser SDK logs in with. */
export async function webrtcToken(credentialId: string): Promise<string> {
  const res = await fetch(`${API}/telephony_credentials/${credentialId}/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("TELNYX_API_KEY")}` },
  });
  if (!res.ok) throw new Error(`telnyx token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.text();
}
