import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";

export const runtime = "nodejs";

/**
 * Nightly call reconciliation (Module 3, ships in Phase 1): GET /v1/calls per
 * Quo phoneNumberId (real timestamps/direction/duration) to catch anything
 * webhooks missed. Runs 08:30 UTC ≈ 00:30/01:30 America/Los_Angeles.
 * Stub so the cron wiring deploys with Phase 0.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, note: "call reconciliation ships in Phase 1" });
}
