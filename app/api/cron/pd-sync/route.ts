import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase";
import { processPdSyncQueue } from "@/lib/pd-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Drain the Pipedrive outbox (every 5 min via pg_cron). */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await processPdSyncQueue(supabaseAdmin(), 40_000);
  return NextResponse.json({ ok: true, ...result });
}
