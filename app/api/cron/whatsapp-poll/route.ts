import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase";
import { klaviyoAccessToken, kOauthFetch } from "@/lib/klaviyo-oauth";
import { syncConversation } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Per-minute WhatsApp detector: one cheap events query against the inbound
 * WhatsApp metric; only profiles with NEW events get a conversation fetch.
 * Keeps steady-state Klaviyo load at ~1 call/min regardless of team size.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = supabaseAdmin();
  const token = await klaviyoAccessToken(db).catch((e) => {
    console.error("klaviyo token", e);
    return null;
  });
  if (!token) return NextResponse.json({ ok: true, skipped: "not connected" });

  // Metric discovery (cached): any metric that looks like inbound WhatsApp.
  const { data: mrow } = await db.from("crm_sync_state").select("value").eq("key", "wa_metric").maybeSingle();
  let metricId: string | null = (mrow?.value as any)?.id ?? null;
  if (!metricId) {
    const metrics = await kOauthFetch(token, "/metrics/");
    const hit = (metrics.data ?? []).find(
      (m: any) =>
        /whatsapp/i.test(m.attributes?.name ?? "") &&
        /(received|reply|replied|inbound)/i.test(m.attributes?.name ?? "")
    ) ?? (metrics.data ?? []).find((m: any) => /received.*whatsapp|whatsapp.*received/i.test(m.attributes?.name ?? ""));
    if (!hit) return NextResponse.json({ ok: true, skipped: "no inbound WhatsApp metric found yet" });
    metricId = hit.id;
    await db
      .from("crm_sync_state")
      .upsert({ key: "wa_metric", value: { id: metricId, name: hit.attributes?.name } }, { onConflict: "key" });
  }

  const { data: crow } = await db.from("crm_sync_state").select("value").eq("key", "wa_cursor").maybeSingle();
  const cursor: string = (crow?.value as any)?.after ?? new Date(Date.now() - 3600_000).toISOString();

  const filter = encodeURIComponent(`equals(metric_id,"${metricId}")`);
  const events = await kOauthFetch(token, `/events/?filter=${filter}&sort=-datetime&include=profile`);
  const rows = (events.data ?? [])
    .map((e: any) => ({
      at: e.attributes?.datetime,
      profileId: e.relationships?.profile?.data?.id ?? null,
    }))
    .filter((r: any) => r.profileId && r.at && r.at > cursor);

  const profiles = [...new Set(rows.map((r: any) => r.profileId))] as string[];
  let synced = 0;
  for (const pid of profiles.slice(0, 20)) {
    try {
      synced += await syncConversation(db, token, pid);
    } catch (e) {
      console.error(`wa sync ${pid}`, e);
    }
  }
  const newest = rows[0]?.at;
  if (newest) {
    await db.from("crm_sync_state").upsert({ key: "wa_cursor", value: { after: newest } }, { onConflict: "key" });
  }
  return NextResponse.json({ ok: true, newEvents: rows.length, profiles: profiles.length, messages: synced });
}
