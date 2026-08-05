import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { env } from "@/lib/env";
import { upsertContactsBatch } from "@/lib/crm-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CURSOR_KEY = "pd_contact_backfill_cursor";
const TIME_BUDGET_MS = 40_000;

/**
 * Re-mirror ALL Pipedrive persons (phones/emails/names) — catches every
 * change made since the original import (mirror webhooks were registered
 * late). Cursor-resumable; call repeatedly until done=true.
 * Cost: ~1 API call per 500 persons (~45 calls for the full book).
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${env("CRON_SECRET")}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = supabaseAdmin();
  const started = Date.now();

  const { data: state } = await db.from("crm_sync_state").select("value").eq("key", CURSOR_KEY).maybeSingle();
  let cursor: string | null = (state?.value as any)?.cursor ?? null;
  let pages = 0;
  let persons = 0;

  while (Date.now() - started < TIME_BUDGET_MS) {
    const u = new URL("https://api.pipedrive.com/api/v2/persons");
    u.searchParams.set("api_token", env("PIPEDRIVE_API_TOKEN"));
    u.searchParams.set("limit", "500");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await fetch(u);
    const json = await res.json().catch(() => ({}));
    if (res.status === 429) {
      return NextResponse.json({ done: false, pages, persons, halted: "rate limit" });
    }
    if (!res.ok || json.success === false) {
      return NextResponse.json(
        { error: `Pipedrive persons ${res.status}`, pages, persons },
        { status: 502 }
      );
    }
    const batch = json.data ?? [];
    await upsertContactsBatch(db, batch);
    pages++;
    persons += batch.length;
    cursor = json.additional_data?.next_cursor ?? null;
    await db.from("crm_sync_state").upsert(
      { key: CURSOR_KEY, value: { cursor }, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    if (!cursor) {
      await db.from("crm_sync_state").delete().eq("key", CURSOR_KEY);
      return NextResponse.json({ done: true, pages, persons });
    }
  }
  return NextResponse.json({ done: false, pages, persons });
}
