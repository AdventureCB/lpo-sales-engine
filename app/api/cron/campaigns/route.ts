import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { advanceEnrollments, evaluateStateTriggers, sendDue } from "@/lib/campaigns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Campaign engine tick (every 15 min): auto-enroll → draft next steps → send approved+due. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const triggers = await evaluateStateTriggers(db).catch((e) => ({ error: e instanceof Error ? e.message : "triggers failed" }));
  const advanced = await advanceEnrollments(db).catch((e) => ({ error: e instanceof Error ? e.message : "advance failed" }));
  const sent = await sendDue(db).catch((e) => ({ error: e instanceof Error ? e.message : "send failed" }));
  return NextResponse.json({ ok: true, triggers, advanced, sent });
}
