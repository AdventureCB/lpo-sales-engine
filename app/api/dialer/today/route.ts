import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { envOptional } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Daily dial goal — the momentum bar's target. */
const DAILY_GOAL = 50;

const isWeekend = (dateStr: string) => {
  const d = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
};

const prevWorkday = (dateStr: string): string => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
};

/**
 * The rep's momentum numbers: today's dials/connects/talk, personal best
 * (90d), and the workday streak of hitting the daily goal. Weekends never
 * break a streak.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!user.repId) return NextResponse.json({ stats: null });

  const tz = envOptional("APP_TIMEZONE") ?? "America/Los_Angeles";
  const db = supabaseAdmin();
  const { data: days, error } = await db.rpc("rep_daily_dials", { p_rep: user.repId, p_tz: tz });
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const byDay = new Map<string, { dials: number; connects: number; talk_s: number }>(
    (days ?? []).map((d: any) => [String(d.day), { dials: Number(d.dials), connects: Number(d.connects), talk_s: Number(d.talk_s) }])
  );

  const today = byDay.get(todayStr) ?? { dials: 0, connects: 0, talk_s: 0 };

  // Personal best excludes today (today competes against it live).
  let bestDials = 0;
  let bestDay: string | null = null;
  for (const [day, v] of byDay) {
    if (day === todayStr) continue;
    if (v.dials > bestDials) {
      bestDials = v.dials;
      bestDay = day;
    }
  }

  // Workday streak of goal-hits, counting today once it's hit.
  let streak = 0;
  if (!isWeekend(todayStr) && (byDay.get(todayStr)?.dials ?? 0) >= DAILY_GOAL) streak++;
  let cursor = prevWorkday(todayStr);
  while ((byDay.get(cursor)?.dials ?? 0) >= DAILY_GOAL) {
    streak++;
    cursor = prevWorkday(cursor);
  }

  return NextResponse.json({
    stats: {
      goal: DAILY_GOAL,
      dialsToday: today.dials,
      connectsToday: today.connects,
      talkSecToday: today.talk_s,
      bestDials,
      bestDay,
      streak,
    },
  });
}
