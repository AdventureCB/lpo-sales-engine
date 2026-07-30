import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scoreboard analytics: dials↔talk-time correlation points, weekly SMS
 * response rate, and lifetime talk-time leaders (15+ min contacts).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const [dialsTalk, smsRate, leaders] = await Promise.all([
    db.rpc("scoreboard_dials_talk", { p_days: 60 }),
    db.rpc("sms_response_rate", { p_days: 120 }),
    db.rpc("talk_time_leaders", { p_min_s: 900 }),
  ]);
  const firstError = dialsTalk.error ?? smsRate.error ?? leaders.error;
  if (firstError) {
    console.error("analytics query failed", firstError);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }
  return NextResponse.json({
    dialsTalk: dialsTalk.data ?? [],
    smsRate: smsRate.data ?? [],
    leaders: leaders.data ?? [],
  });
}
