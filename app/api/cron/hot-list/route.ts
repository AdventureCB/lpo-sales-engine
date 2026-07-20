import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";

export const runtime = "nodejs";

/**
 * 15-min hot-list sweep (Module 2, ships in Phase 2): pull Klaviyo +
 * Pipedrive engagement signals, score against app_config.hot_rules, flag
 * deals. Stub so the cron wiring deploys with Phase 0.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, note: "hot-list sweep ships in Phase 2" });
}
