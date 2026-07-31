import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { kOauthFetch } from "./klaviyo-oauth";
import { normalizeEmail, normalizePhone } from "./identity";

/**
 * WhatsApp via Klaviyo Conversations: pull a profile's conversation into
 * whatsapp_messages (the inbox reads only our DB), mirror each message onto
 * the contact timeline, and enqueue automation events for new inbound.
 */

/** Find the CRM contact for a Klaviyo profile (email first, then phone). */
async function matchContact(db: SupabaseClient, token: string, profileId: string): Promise<string | null> {
  const { data: known } = await db
    .from("whatsapp_messages")
    .select("contact_id")
    .eq("profile_id", profileId)
    .not("contact_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (known?.contact_id) return known.contact_id;

  const profile = await kOauthFetch(token, `/profiles/${profileId}/`).catch(() => null);
  const attrs = profile?.data?.attributes ?? {};
  const email = normalizeEmail(attrs.email);
  if (email) {
    const { data } = await db
      .from("crm_contacts")
      .select("id")
      .contains("emails", JSON.stringify([{ value: email }]))
      .maybeSingle();
    if (data) return data.id;
  }
  const phone = normalizePhone(attrs.phone_number);
  if (phone) {
    const { data } = await db
      .from("crm_contacts")
      .select("id")
      .contains("phones", JSON.stringify([{ e164: phone }]))
      .maybeSingle();
    if (data) return data.id;
  }
  return null;
}

/**
 * Fetch + mirror one profile's conversation. Returns how many messages were
 * new. Message schema handled defensively (API is early-access).
 */
export async function syncConversation(
  db: SupabaseClient,
  token: string,
  profileId: string
): Promise<number> {
  const convo = await kOauthFetch(token, `/profiles/${profileId}/conversation`);
  const messages: any[] = Array.isArray(convo?.data) ? convo.data : convo?.data ? [convo.data] : [];
  const flat = messages.flatMap((m: any) =>
    Array.isArray(m?.attributes?.messages) ? m.attributes.messages : [m]
  );
  if (flat.length === 0) return 0;

  const contactId = await matchContact(db, token, profileId);
  let fresh = 0;
  for (const m of flat) {
    const a = m.attributes ?? m;
    const messageId = m.id ?? a.id ?? `${profileId}:${a.datetime ?? a.sent_at ?? ""}:${(a.body ?? "").slice(0, 40)}`;
    const direction =
      a.direction === "inbound" || a.from_profile === true || a.sender === "profile" ? "inbound" : "outbound";
    const body = a.body ?? a.content ?? a.text ?? null;
    const sentAt = a.datetime ?? a.sent_at ?? a.created ?? null;
    if (!body) continue;
    const { data: inserted, error } = await db
      .from("whatsapp_messages")
      .upsert(
        {
          klaviyo_message_id: String(messageId),
          profile_id: profileId,
          contact_id: contactId,
          direction,
          body,
          sent_at: sentAt,
          raw: m,
        },
        { onConflict: "klaviyo_message_id", ignoreDuplicates: true }
      )
      .select("id");
    if (error) {
      console.error("wa upsert failed", error.message);
      continue;
    }
    if ((inserted ?? []).length === 0) continue; // already had it
    fresh++;
    // Timeline mirror + automation event for new inbound.
    await db.from("crm_activities").upsert(
      {
        pd_key: `wa:${messageId}`,
        contact_id: contactId,
        type: "sms",
        subject: `${direction === "inbound" ? "📥" : "📤"} WhatsApp`,
        body,
        actor: direction === "inbound" ? "customer" : "team",
        occurred_at: sentAt ?? new Date().toISOString(),
        meta: { whatsapp: true, profile_id: profileId },
      },
      { onConflict: "pd_key", ignoreDuplicates: true }
    );
    if (direction === "inbound") {
      const { enqueueEvent } = await import("./automations");
      await enqueueEvent(db, "inbound_whatsapp", {
        profile_id: profileId,
        contact_id: contactId,
        body: body.slice(0, 500),
      });
    }
  }
  return fresh;
}
