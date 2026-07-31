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
  const [dialsTalk, smsRate, leaders, journeyTalk, journeys, reps] = await Promise.all([
    db.rpc("scoreboard_dials_talk", { p_days: 60 }),
    db.rpc("sms_response_rate", { p_days: 120 }),
    db.rpc("talk_time_leaders", { p_min_s: 900 }),
    db.rpc("journey_talk_times"),
    db
      .from("sales_journeys")
      .select("id, rep_id, state, deposit_started_at, confirmed_at")
      .limit(2000),
    db.from("reps").select("id, name"),
  ]);
  const firstError =
    dialsTalk.error ?? smsRate.error ?? leaders.error ?? journeyTalk.error ?? journeys.error ?? reps.error;
  if (firstError) {
    console.error("analytics query failed", firstError);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  // Per-journey talk investment, flattened for the trend charts.
  const repName = new Map((reps.data ?? []).map((r) => [r.id, r.name]));
  const talkById = new Map(
    (journeyTalk.data ?? []).map((t: any) => [t.journey_id as string, t])
  );
  const journeyTalkRows = (journeys.data ?? [])
    .map((j) => {
      const t: any = talkById.get(j.id);
      return {
        rep: j.rep_id ? repName.get(j.rep_id) ?? null : null,
        state: j.state,
        depositAt: j.deposit_started_at,
        confirmedAt: j.confirmed_at,
        toDepositS: t?.talk_to_deposit_s ?? 0,
        toConfirmS: t?.talk_to_confirm_s ?? 0,
      };
    })
    .filter((r) => r.rep && (r.toDepositS > 0 || r.toConfirmS > 0));

  return NextResponse.json({
    dialsTalk: dialsTalk.data ?? [],
    smsRate: smsRate.data ?? [],
    leaders: leaders.data ?? [],
    journeyTalk: journeyTalkRows,
  });
}
