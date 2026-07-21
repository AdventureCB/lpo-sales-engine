import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Poll target for the dialer: has the call to `phone` (started after
 * `since`) shown up via Quo webhooks, and is it completed? Matched via the
 * participants array on the stored webhook payload.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const phone = params.get("phone");
  const since = params.get("since");
  if (!phone || !since) {
    return NextResponse.json({ error: "phone and since required" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("call_events")
    .select("quo_call_id, status, direction, started_at, answered_at, completed_at, duration_s")
    .contains("raw", { data: { object: { participants: [phone] } } })
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("call-status query failed", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }
  if (!data) return NextResponse.json({ call: null });
  return NextResponse.json({
    call: {
      quoCallId: data.quo_call_id,
      status: data.status,
      completed: Boolean(data.completed_at) || data.status === "completed",
      durationS: data.duration_s,
    },
  });
}
