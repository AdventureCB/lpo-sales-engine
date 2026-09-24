import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSms, telnyxConfigured } from "./telnyx";
import { linkifyPlain } from "./richtext";

/**
 * Send a text from a rep's own Telnyx number with the same bookkeeping as
 * POST /api/texts/send (sms_messages row + timeline entry), callable from
 * server code (campaign sends). Markdown links flatten to "label: url"
 * because SMS has no hyperlinks.
 */
export async function sendTrackedSms(
  db: SupabaseClient,
  opts: { actorEmail: string; to: string; body: string; dealId: string | null; contactId: string | null; meta?: Record<string, unknown> }
): Promise<{ messageId: string; activityId: string | null }> {
  if (!telnyxConfigured()) throw new Error("Telnyx not configured");
  const { data: rep } = await db.from("reps").select("id, telnyx_number").eq("email", opts.actorEmail).maybeSingle();
  if (!rep?.telnyx_number) throw new Error(`${opts.actorEmail} has no Telnyx number`);
  const text = linkifyPlain(opts.body).trim();
  const sent = await sendSms({ from: rep.telnyx_number, to: opts.to, text });
  await db.from("sms_messages").upsert(
    {
      provider: "telnyx", provider_message_id: sent.id ?? `local-${opts.to}-${Date.now()}`, rep_id: rep.id, direction: "outgoing",
      status: sent.status ?? "queued", phone_number_id: null, our_number: sent.from, peer_phone: opts.to, body: text, media: null, sent_at: sent.sentAt,
    },
    { onConflict: "provider,provider_message_id", ignoreDuplicates: false }
  );
  const { data: act } = await db
    .from("crm_activities")
    .insert({
      deal_id: opts.dealId, contact_id: opts.contactId, type: "sms", subject: "💬 Text sent", body: text.slice(0, 500),
      actor: opts.actorEmail, occurred_at: new Date().toISOString(), meta: { direction: "outbound", ...(opts.meta ?? {}) },
    })
    .select("id")
    .single();
  return { messageId: sent.id, activityId: act?.id ?? null };
}
