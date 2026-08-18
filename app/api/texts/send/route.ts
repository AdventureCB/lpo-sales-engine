import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { normalizePhone } from "@/lib/identity";
import { env } from "@/lib/env";
import { telnyxConfigured, sendSms } from "@/lib/telnyx";

export const runtime = "nodejs";

// Shared-inbox fallback line ("Customer Service") — same default the
// automation engine sends from.
const FALLBACK_LINE = "PN2nRozOQb";

/**
 * Send a text through Quo (the team's live provider until the Telnyx
 * migration; rows are provider-tagged so the swap is transparent).
 * Sends from the rep's own Quo line when they have one.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    to?: string;
    body?: string;
    from?: string;
    crmDealId?: string;
    contactId?: string;
    mediaUrls?: string[];
    force?: boolean; // rep confirmed sending to an opted-out contact
    optInRequest?: boolean; // send the standard re-opt-in invitation instead
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const to = normalizePhone(body.to ?? null);
  let content = body.body?.trim() ?? "";
  const mediaUrls = (body.mediaUrls ?? []).filter((u) => typeof u === "string" && u.startsWith("https://")).slice(0, 5);
  if (!to || (!content && mediaUrls.length === 0)) {
    return NextResponse.json({ error: "to and body (or an image) required" }, { status: 400 });
  }

  const db = supabaseAdmin();

  // ── Consent gate: texting someone who opted out needs an explicit choice —
  // send the standard opt-in request, force (existing conversation), or stop.
  const { data: consentMatch } = await db.rpc("contacts_by_phones", { p_phones: [to] });
  const contactMatchId = consentMatch?.[0]?.contact_id ?? null;
  if (contactMatchId) {
    const { data: c } = await db.from("crm_contacts").select("sms_consent").eq("id", contactMatchId).maybeSingle();
    if (c?.sms_consent === "opted_out" && !body.force && !body.optInRequest) {
      return NextResponse.json(
        { error: "opted_out", optedOut: true },
        { status: 409 }
      );
    }
  }
  if (body.optInRequest) {
    const rep = user.repName ?? user.email.split("@")[0];
    content = `Lone Peak Overland: ${rep} wants to send you a message. Reply START to receive texts. Msg & data rates may apply. Reply STOP to opt out.`;
  }

  // Provider follows the rep's assigned number: a rep with a telnyx_number
  // texts via Telnyx (10DLC), otherwise Quo. Reps get Telnyx numbers as their
  // Quo numbers port over, so this flips per-rep automatically.
  let telnyxNumber: string | null = null;
  let quoLine: string | null = body.from ?? null;
  if (user.repId) {
    const { data: rep } = await db
      .from("reps")
      .select("telnyx_number, quo_phone_number_id")
      .eq("id", user.repId)
      .maybeSingle();
    telnyxNumber = rep?.telnyx_number ?? null;
    if (!quoLine) quoLine = rep?.quo_phone_number_id ?? null;
  }

  let row: Record<string, unknown>;
  if (telnyxNumber && telnyxConfigured()) {
    try {
      const sent = await sendSms({ from: telnyxNumber, to, text: content, mediaUrls: mediaUrls.length ? mediaUrls : undefined });
      row = {
        provider: "telnyx",
        provider_message_id: sent.id ?? `local-${to}-${Date.now()}`,
        rep_id: user.repId ?? null,
        direction: "outgoing",
        status: sent.status ?? "queued",
        phone_number_id: null,
        our_number: sent.from,
        peer_phone: to,
        body: content || null,
        media: mediaUrls.length ? mediaUrls : null,
        sent_at: sent.sentAt,
      };
    } catch (e) {
      return NextResponse.json({ error: `Telnyx send failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
    }
  } else {
    if (mediaUrls.length > 0) {
      return NextResponse.json({ error: "Images require a Telnyx line (assigned after your number ports)" }, { status: 400 });
    }
    const from = quoLine ?? FALLBACK_LINE;
    const res = await fetch("https://api.quo.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: env("QUO_API_KEY"),
        "Content-Type": "application/json",
        "User-Agent": "lpo-sales-engine/0.1",
      },
      body: JSON.stringify({ content, from, to: [to] }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      return NextResponse.json({ error: `Quo send failed (${res.status}): ${detail}` }, { status: 502 });
    }
    const sent = (await res.json().catch(() => ({})))?.data ?? {};
    row = {
      provider: "quo",
      provider_message_id: sent.id ?? `local-${to}-${Date.now()}`,
      rep_id: user.repId ?? null,
      direction: "outgoing",
      status: sent.status ?? "sent",
      phone_number_id: sent.phoneNumberId ?? (from.startsWith("PN") ? from : null),
      our_number: typeof sent.from === "string" ? sent.from : null,
      peer_phone: to,
      body: content,
      sent_at: sent.createdAt ?? new Date().toISOString(),
    };
  }

  // Store immediately so the UI reflects it without waiting on the webhook
  // (which dedupes on the same provider message id).
  await db
    .from("sms_messages")
    .upsert(row, { onConflict: "provider,provider_message_id", ignoreDuplicates: false });

  // Deal-page sends land on the timeline immediately.
  if (body.crmDealId || body.contactId) {
    await db.from("crm_activities").insert({
      deal_id: body.crmDealId ?? null,
      contact_id: body.contactId ?? null,
      type: "sms",
      subject: "💬 Text sent",
      body: (content || "📷 photo").slice(0, 500),
      actor: user.email,
      occurred_at: new Date().toISOString(),
      ...(mediaUrls.length ? { meta: { media: mediaUrls } } : {}),
    });
  }

  return NextResponse.json({
    ok: true,
    message: {
      id: row.provider_message_id,
      direction: "outgoing",
      status: row.status,
      body: content || null,
      media: mediaUrls.length ? mediaUrls : null,
      at: row.sent_at,
      rep: user.repName ?? null,
      ourNumber: row.our_number,
    },
  });
}
