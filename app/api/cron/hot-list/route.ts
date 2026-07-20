import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";

export const runtime = "nodejs";

/**
 * Hot-list sweep (Module 2, ships in Phase 2): pull Klaviyo + Pipedrive
 * engagement signals, score against app_config.hot_rules, flag deals.
 * Stub so the cron wiring deploys with Phase 0.
 *
 * Vercel Hobby only allows daily crons, so vercel.json runs this once/day.
 * The spec wants every 15 min — in Phase 2, schedule it via Supabase pg_cron
 * + pg_net hitting this endpoint (free) or upgrade Vercel to Pro.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, note: "hot-list sweep ships in Phase 2" });
}
