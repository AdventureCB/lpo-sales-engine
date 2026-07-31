import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { klaviyoAccessToken, kOauthFetch } from "@/lib/klaviyo-oauth";
import { syncConversation } from "@/lib/whatsapp";

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
  let body: { profileId?: string; message?: string; refresh?: boolean };
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
    // One live pull per profile per 10s, however many viewers/poll ticks.
    const key = `wa_refresh:${body.profileId}`;
    const { data: last } = await db.from("crm_sync_state").select("value").eq("key", key).maybeSingle();
    const lastAt = (last?.value as any)?.at ?? 0;
    if (Date.now() - lastAt < 10_000) return NextResponse.json({ ok: true, throttled: true });
    await db.from("crm_sync_state").upsert({ key, value: { at: Date.now() } }, { onConflict: "key" });
    const fresh = await syncConversation(db, token, body.profileId).catch((e) => {
      console.error("wa refresh", e);
      return 0;
    });
    return NextResponse.json({ ok: true, fresh });
  }

  const text = body.message?.trim();
  if (!text) return NextResponse.json({ error: "message required" }, { status: 400 });
  if (text.length > 1024) return NextResponse.json({ error: "WhatsApp messages max 1024 chars" }, { status: 400 });

  try {
    await kOauthFetch(token, "/conversation-messages/", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "conversation-message",
          attributes: { channel: "whatsapp", body: text },
          relationships: { profile: { data: { type: "profile", id: body.profileId } } },
        },
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Common until Klaviyo approves Conversations access for the account.
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Optimistic local echo; the next sync reconciles with Klaviyo's record.
  await db.from("whatsapp_messages").insert({
    klaviyo_message_id: `local:${crypto.randomUUID()}`,
    profile_id: body.profileId,
    direction: "outbound",
    body: text,
    sent_at: new Date().toISOString(),
    raw: { sent_by: user.email },
  });
  return NextResponse.json({ ok: true });
}
