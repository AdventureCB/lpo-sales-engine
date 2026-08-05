import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { klaviyoAccessToken } from "@/lib/klaviyo-oauth";
import { discoverWaMetrics, sendWhatsApp, syncWhatsAppEvents } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * WhatsApp inbox. GET: threads (or one thread's messages with ?profile=).
 * POST: send a reply, or {refresh} to live-pull an open thread (throttled
 * per profile so an open chat can poll without hammering Klaviyo).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const profileId = new URL(req.url).searchParams.get("profile");

  const { data: oauth } = await db.from("klaviyo_oauth").select("status, connected_by").eq("id", 1).maybeSingle();
  const connected = Boolean(oauth && oauth.status !== "disconnected");

  if (profileId) {
    const { data: messages } = await db
      .from("whatsapp_messages")
      .select("klaviyo_message_id, direction, body, sent_at")
      .eq("profile_id", profileId)
      .order("sent_at", { ascending: true })
      .limit(200);
    return NextResponse.json({ connected, messages: messages ?? [] });
  }

  // Threads: latest message per profile + contact name.
  const { data: recent } = await db
    .from("whatsapp_messages")
    .select("profile_id, contact_id, direction, body, sent_at, crm_contacts ( name )")
    .order("sent_at", { ascending: false })
    .limit(400);
  const threads = new Map<string, any>();
  for (const m of recent ?? []) {
    if (!threads.has(m.profile_id)) {
      threads.set(m.profile_id, {
        profileId: m.profile_id,
        contactName: (m as any).crm_contacts?.name ?? null,
        lastBody: m.body,
        lastDirection: m.direction,
        lastAt: m.sent_at,
      });
    }
  }
  return NextResponse.json({ connected, threads: [...threads.values()] });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { profileId?: string; message?: string; refresh?: boolean; dealId?: string; contactId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.profileId) return NextResponse.json({ error: "profileId required" }, { status: 400 });

  const db = supabaseAdmin();
  const token = await klaviyoAccessToken(db).catch(() => null);
  if (!token) return NextResponse.json({ error: "Klaviyo not connected" }, { status: 503 });

  if (body.refresh) {
    // One live event sweep per 10s total, however many viewers/poll ticks —
    // the event queries cover every thread at once.
    const key = "wa_refresh";
    const { data: last } = await db.from("crm_sync_state").select("value").eq("key", key).maybeSingle();
    const lastAt = (last?.value as any)?.at ?? 0;
    if (Date.now() - lastAt < 10_000) return NextResponse.json({ ok: true, throttled: true });
    await db.from("crm_sync_state").upsert({ key, value: { at: Date.now() } }, { onConflict: "key" });
    const metrics = await discoverWaMetrics(db, token);
    if (!metrics) return NextResponse.json({ ok: true, fresh: 0 });
    const { data: crow } = await db.from("crm_sync_state").select("value").eq("key", "wa_cursor").maybeSingle();
    const cursor: string = (crow?.value as any)?.after ?? new Date(Date.now() - 86400_000).toISOString();
    const { fresh, newestAt } = await syncWhatsAppEvents(db, token, metrics, cursor).catch((e) => {
      console.error("wa refresh", e);
      return { fresh: 0, newestAt: null };
    });
    if (newestAt) {
      await db.from("crm_sync_state").upsert({ key: "wa_cursor", value: { after: newestAt } }, { onConflict: "key" });
    }
    return NextResponse.json({ ok: true, fresh });
  }

  const text = body.message?.trim();
  if (!text) return NextResponse.json({ error: "message required" }, { status: 400 });
  if (text.length > 1024) return NextResponse.json({ error: "WhatsApp messages max 1024 chars" }, { status: 400 });

  try {
    await sendWhatsApp(db, token, body.profileId, text, user.email);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
  // Deal-page sends land on the timeline immediately.
  if (body.dealId || body.contactId) {
    await db.from("crm_activities").insert({
      deal_id: body.dealId ?? null,
      contact_id: body.contactId ?? null,
      type: "sms",
      subject: "🟢 WhatsApp sent",
      body: text.slice(0, 500),
      actor: user.email,
      occurred_at: new Date().toISOString(),
    });
  }
  return NextResponse.json({ ok: true });
}
