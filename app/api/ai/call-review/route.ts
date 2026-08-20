import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { reviewCall } from "@/lib/ai-call-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * StoryBrand coaching review of one call. Manual-only; cached per
 * transcript+profile-version so re-pressing the button is free. Pass
 * activityId (crm_activities call row) OR callId (call_events quo_call_id).
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { dealId?: string; activityId?: string; callId?: string; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.dealId || (!body.activityId && !body.callId)) {
    return NextResponse.json({ error: "dealId and activityId|callId required" }, { status: 400 });
  }
  const result = await reviewCall(supabaseAdmin(), {
    dealId: body.dealId,
    activityId: body.activityId ?? null,
    quoCallId: body.callId ?? null,
    force: body.force === true,
  });
  if (!result.ok) return NextResponse.json({ error: result.reason ?? "failed" }, { status: 422 });
  return NextResponse.json({ ok: true, review: result.review, cached: result.cached === true, reviewedAt: result.reviewedAt });
}
