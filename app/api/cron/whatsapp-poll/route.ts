import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase";
import { klaviyoAccessToken } from "@/lib/klaviyo-oauth";
import { discoverWaMetrics, syncWhatsAppEvents } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Per-minute WhatsApp sync: two cheap event queries (inbound + outbound
 * metrics) — steady-state Klaviyo load ~2 calls/min regardless of volume.
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

  const metrics = await discoverWaMetrics(db, token);
  if (!metrics) return NextResponse.json({ ok: true, skipped: "no WhatsApp metrics found yet" });

  const { data: crow } = await db.from("crm_sync_state").select("value").eq("key", "wa_cursor").maybeSingle();
  const cursor: string = (crow?.value as any)?.after ?? new Date(Date.now() - 86400_000).toISOString();

  const { fresh, newestAt } = await syncWhatsAppEvents(db, token, metrics, cursor);
  if (newestAt) {
    await db.from("crm_sync_state").upsert({ key: "wa_cursor", value: { after: newestAt } }, { onConflict: "key" });
  }
  return NextResponse.json({ ok: true, fresh });
}
