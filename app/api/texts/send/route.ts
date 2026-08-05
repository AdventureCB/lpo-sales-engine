import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { normalizePhone } from "@/lib/identity";
import { env } from "@/lib/env";

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

  let body: { to?: string; body?: string; from?: string; crmDealId?: string; contactId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const to = normalizePhone(body.to ?? null);
  const content = body.body?.trim();
  if (!to || !content) {
    return NextResponse.json({ error: "to and body required" }, { status: 400 });
  }

  const db = supabaseAdmin();
  let from = body.from ?? null;
  if (!from && user.repId) {
    const { data: rep } = await db
      .from("reps")
      .select("quo_phone_number_id")
      .eq("id", user.repId)
      .maybeSingle();
    from = rep?.quo_phone_number_id ?? null;
  }
  from = from ?? FALLBACK_LINE;

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

  // Store immediately so the UI reflects it without waiting on the webhook
  // (which dedupes on the same provider message id).
  const row = {
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
      body: content.slice(0, 500),
      actor: user.email,
      occurred_at: new Date().toISOString(),
    });
  }

  return NextResponse.json({
    ok: true,
    message: {
      id: row.provider_message_id,
      direction: "outgoing",
      status: row.status,
      body: content,
      at: row.sent_at,
      rep: user.repName ?? null,
      ourNumber: row.our_number,
    },
  });
}
