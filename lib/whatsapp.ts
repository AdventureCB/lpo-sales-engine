import "server-only";
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { kOauthFetch } from "./klaviyo-oauth";
import { normalizeEmail, normalizePhone } from "./identity";

/**
 * WhatsApp via Klaviyo. Threads are assembled from EVENTS (verified against
 * the live account): "Sent WhatsApp" = customer → us, with Message Body in
 * the properties; "Received WhatsApp" = us → customer (no body exposed —
 * our own sends echo locally, Klaviyo-originated sends get a placeholder).
 * Replies go through POST /api/conversation-messages against the profile's
 * conversation id (resolved via GET /profiles/{id}/conversations).
 */

export interface WaMetricIds {
  inbound: string; // "Sent WhatsApp" (profile sent us a message)
  outbound: string; // "Received WhatsApp" (profile received our message)
}

export async function discoverWaMetrics(db: SupabaseClient, token: string): Promise<WaMetricIds | null> {
  const { data: cached } = await db.from("crm_sync_state").select("value").eq("key", "wa_metrics").maybeSingle();
  const val = cached?.value as any;
  if (val?.inbound && val?.outbound) return val;
  const metrics = await kOauthFetch(token, "/metrics/");
  const byName = (n: string) =>
    (metrics.data ?? []).find((m: any) => (m.attributes?.name ?? "").toLowerCase() === n)?.id ?? null;
  const inbound = byName("sent whatsapp");
  const outbound = byName("received whatsapp");
  if (!inbound) return null;
  const ids = { inbound, outbound };
  await db.from("crm_sync_state").upsert({ key: "wa_metrics", value: ids }, { onConflict: "key" });
  return ids;
}

async function matchContact(
  db: SupabaseClient,
  token: string,
  profileId: string,
  peerPhone: string | null
): Promise<string | null> {
  const { data: known } = await db
    .from("whatsapp_messages")
    .select("contact_id")
    .eq("profile_id", profileId)
    .not("contact_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (known?.contact_id) return known.contact_id;

  const phone = normalizePhone(peerPhone);
  if (phone) {
    const { data } = await db
      .from("crm_contacts")
      .select("id")
      .contains("phones", JSON.stringify([{ e164: phone }]))
      .maybeSingle();
    if (data) return data.id;
  }
  const profile = await kOauthFetch(token, `/profiles/${profileId}/`).catch(() => null);
  const email = normalizeEmail(profile?.data?.attributes?.email);
  if (email) {
    const { data } = await db
      .from("crm_contacts")
      .select("id")
      .contains("emails", JSON.stringify([{ value: email }]))
      .maybeSingle();
    if (data) return data.id;
  }
  return null;
}

/**
 * Pull WhatsApp events (both directions) newer than the cursor into
 * whatsapp_messages + contact timelines. Returns {fresh, newestAt}.
 */
export async function syncWhatsAppEvents(
  db: SupabaseClient,
  token: string,
  metricIds: WaMetricIds,
  cursor: string
): Promise<{ fresh: number; newestAt: string | null }> {
  const directions: Array<{ metricId: string; direction: "inbound" | "outbound" }> = [
    { metricId: metricIds.inbound, direction: "inbound" },
    { metricId: metricIds.outbound, direction: "outbound" },
  ];
  let fresh = 0;
  let newestAt: string | null = null;

  for (const { metricId, direction } of directions) {
    const filter = encodeURIComponent(`equals(metric_id,"${metricId}")`);
    const page = await kOauthFetch(token, `/events/?filter=${filter}&sort=-datetime&include=profile`);
    for (const e of page.data ?? []) {
      const at = e.attributes?.datetime;
      const profileId = e.relationships?.profile?.data?.id;
      if (!at || !profileId || at <= cursor) continue;
      if (!newestAt || at > newestAt) newestAt = at;

      const props = e.attributes?.event_properties ?? {};
      const messageId =
        props?.$extra?.["Message ID"] ?? props?.["$event_id"] ?? `${direction}:${profileId}:${at}`;
      const body =
        props["Message Body"] ??
        (direction === "outbound" ? "📤 (message sent via Klaviyo)" : null);
      if (!body) continue;
      const peerPhone = direction === "inbound" ? props["From Number"] : props["To Number"];

      const contactId = await matchContact(db, token, profileId, peerPhone ?? null);
      const { data: inserted, error } = await db
        .from("whatsapp_messages")
        .upsert(
          {
            klaviyo_message_id: String(messageId),
            profile_id: profileId,
            contact_id: contactId,
            direction,
            body,
            sent_at: at,
            raw: { properties: props, peer_phone: peerPhone ?? null },
          },
          { onConflict: "klaviyo_message_id", ignoreDuplicates: true }
        )
        .select("id");
      if (error || (inserted ?? []).length === 0) continue;
      fresh++;

      await db.from("crm_activities").upsert(
        {
          pd_key: `wa:${messageId}`,
          contact_id: contactId,
          type: "sms",
          subject: `${direction === "inbound" ? "📥" : "📤"} WhatsApp`,
          body,
          actor: direction === "inbound" ? peerPhone ?? "customer" : "team",
          occurred_at: at,
          meta: { whatsapp: true, profile_id: profileId },
        },
        { onConflict: "pd_key", ignoreDuplicates: true }
      );
      if (direction === "inbound") {
        const { enqueueEvent } = await import("./automations");
        await enqueueEvent(db, "inbound_whatsapp", {
          profile_id: profileId,
          contact_id: contactId,
          phone: peerPhone ?? null,
          body: String(body).slice(0, 500),
        });
      }
    }
  }
  return { fresh, newestAt };
}

/** The profile's WhatsApp conversation id (cached) — needed for replies. */
export async function conversationIdForProfile(
  db: SupabaseClient,
  token: string,
  profileId: string
): Promise<string | null> {
  const key = `wa_convo:${profileId}`;
  const { data: cached } = await db.from("crm_sync_state").select("value").eq("key", key).maybeSingle();
  const known = (cached?.value as any)?.id;
  if (known) return known;
  const res = await kOauthFetch(token, `/profiles/${profileId}/conversations`);
  const convo = (res.data ?? []).find((c: any) => c.attributes?.channel === "whatsapp");
  if (!convo) return null;
  await db.from("crm_sync_state").upsert({ key, value: { id: convo.id } }, { onConflict: "key" });
  return convo.id;
}

/** Send a WhatsApp reply; echoes into the local thread on success. */
export async function sendWhatsApp(
  db: SupabaseClient,
  token: string,
  profileId: string,
  text: string,
  sentBy: string
): Promise<void> {
  const conversationId = await conversationIdForProfile(db, token, profileId);
  if (!conversationId) throw new Error("No WhatsApp conversation exists for this contact yet");
  await kOauthFetch(token, "/conversation-messages/", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "conversation-message",
        attributes: { body: text },
        relationships: { conversation: { data: { type: "conversation", id: conversationId } } },
      },
    }),
  });
  const { data: known } = await db
    .from("whatsapp_messages")
    .select("contact_id")
    .eq("profile_id", profileId)
    .not("contact_id", "is", null)
    .limit(1)
    .maybeSingle();
  await db.from("whatsapp_messages").insert({
    klaviyo_message_id: `local:${crypto.randomUUID()}`,
    profile_id: profileId,
    contact_id: known?.contact_id ?? null,
    direction: "outbound",
    body: text,
    sent_at: new Date().toISOString(),
    raw: { sent_by: sentBy },
  });
}
