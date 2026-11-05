import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { reconcileFromOps } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Nightly Ops reconcile (pg_cron 10:00 UTC): pulls events from Ops' cursor
 * endpoint (docs/ops-integration.md §7) so anything a webhook delivery missed
 * still lands. Idempotent — events already received are duplicates.
 * First run with no cursor = the historical backfill.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await reconcileFromOps(supabaseAdmin()));
  } catch (e) {
    console.error("ops reconcile failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
