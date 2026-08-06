import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { env } from "@/lib/env";
import { upsertActivitiesBatch } from "@/lib/crm-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CURSOR_KEY = "pd_activity_backfill_cursor";
const TIME_BUDGET_MS = 42_000;

/**
 * Re-mirror all Pipedrive activities so completions/edits made after the
 * original import land in crm_activities (with corrected occurred_at =
 * done-time). Fixes already-stale rows. Cursor-resumable; call until
 * done=true, then it recomputes every deal's last_activity_at.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${env("CRON_SECRET")}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = supabaseAdmin();
  const started = Date.now();
  const token = env("PIPEDRIVE_API_TOKEN");

  const { data: state } = await db.from("crm_sync_state").select("value").eq("key", CURSOR_KEY).maybeSingle();
  let start: number = (state?.value as any)?.start ?? 0;
  let pages = 0;
  let activities = 0;

  while (Date.now() - started < TIME_BUDGET_MS) {
    // v1 activities: start/limit pagination, includes done + undone.
    const u = new URL("https://api.pipedrive.com/v1/activities");
    u.searchParams.set("api_token", token);
    u.searchParams.set("user_id", "0"); // 0 = all users
    u.searchParams.set("start", String(start));
    u.searchParams.set("limit", "500");
    const res = await fetch(u);
    const json = await res.json().catch(() => ({}));
    if (res.status === 429) return NextResponse.json({ done: false, pages, activities, halted: "rate limit" });
    if (!res.ok || json.success === false) {
      return NextResponse.json({ error: `Pipedrive activities ${res.status}`, pages, activities }, { status: 502 });
    }
    const batch = json.data ?? [];
    if (batch.length > 0) {
      await upsertActivitiesBatch(db, batch);
      activities += batch.length;
    }
    pages++;
    const more = json.additional_data?.pagination?.more_items_in_collection;
    start = json.additional_data?.pagination?.next_start ?? start + batch.length;
    await db.from("crm_sync_state").upsert(
      { key: CURSOR_KEY, value: { start }, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    if (!more || batch.length === 0) {
      await db.from("crm_sync_state").delete().eq("key", CURSOR_KEY);
      await db.rpc("refresh_deal_last_activity").then(() => {}, () => {});
      return NextResponse.json({ done: true, pages, activities, recomputed: true });
    }
  }
  return NextResponse.json({ done: false, pages, activities });
}
