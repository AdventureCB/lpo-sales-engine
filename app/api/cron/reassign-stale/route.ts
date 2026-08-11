import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { loadReassignConfig, sweepInactiveDeals } from "@/lib/reassign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Daily early-morning job: sweep rep-owned deals with no rep-initiated
 * activity inside the configured window (and no deposit) into the shared
 * reprospecting pool. ?dry=1 previews without writing.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const cfg = await loadReassignConfig(db);
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  if (!cfg.enabled && !dry) return NextResponse.json({ skipped: "disabled" });

  const res = await sweepInactiveDeals(db, cfg, { dryRun: dry });
  return NextResponse.json({
    dryRun: dry,
    inactiveDays: cfg.inactive_days,
    matched: res.matched,
    reassigned: res.reassigned,
    capped: res.capped,
  });
}
