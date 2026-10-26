import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { advanceEnrollments, evaluateStateTriggers, sendDue, sweepReplies } from "@/lib/campaigns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Campaign engine tick (every 15 min): auto-enroll → draft next steps → send approved+due. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const t0 = Date.now();
  // Replies first (so a queued step never goes to someone who just wrote
  // back), then send (due messages must never wait on enrollment work), then
  // enroll and draft inside a time budget — the rest carries to the next pass.
  const replies = await sweepReplies(db).catch((e) => ({ error: e instanceof Error ? e.message : "reply sweep failed" }));
  const sent = await sendDue(db).catch((e) => ({ error: e instanceof Error ? e.message : "send failed" }));
  const triggers = await evaluateStateTriggers(db, { deadline: t0 + 60_000, perCampaign: 25 }).catch((e) => ({ error: e instanceof Error ? e.message : "triggers failed" }));
  const advanced = await advanceEnrollments(db, { deadline: t0 + 105_000 }).catch((e) => ({ error: e instanceof Error ? e.message : "advance failed" }));
  const result = { at: new Date().toISOString(), ms: Date.now() - t0, replies, sent, triggers, advanced };
  await db.from("crm_sync_state").upsert({ key: "campaigns_last_run", value: result, updated_at: result.at }, { onConflict: "key" });
  return NextResponse.json({ ok: true, ...result });
}
