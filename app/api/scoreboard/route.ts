import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { buildScoreboard } from "@/lib/scoreboard";
import { envOptional } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOOKBACK_DAYS = 40; // covers month + both weeks

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Standard ranges (day/week/lastweek/month) in one response, or a custom
 * range via ?start=YYYY-MM-DD&end=YYYY-MM-DD.
 */
export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const start = params.get("start");
  const end = params.get("end");
  let custom: { start: string; end: string } | undefined;
  if (start || end) {
    if (
      !start || !end || !DATE_RE.test(start) || !DATE_RE.test(end) ||
      start > end ||
      (Date.parse(end) - Date.parse(start)) / 86400_000 > 400
    ) {
      return NextResponse.json({ error: "invalid date range" }, { status: 400 });
    }
    custom = { start, end };
  }

  const db = supabaseAdmin();
  const since = custom
    ? // one extra day so timezone offset can't clip the range's first morning
      new Date(Date.parse(`${custom.start}T00:00:00Z`) - 86400_000).toISOString()
    : new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();

  const [repsRes, callsRes, messagesRes, journeysRes] = await Promise.all([
    db.from("reps").select("id, name").eq("active", true).order("sort_order"),
    db
      .from("call_events")
      .select("rep_id, direction, started_at, answered_at, duration_s, classification, disposition")
      .gte("started_at", since),
    db.from("message_events").select("rep_id, direction, sent_at").gte("sent_at", since),
    db
      .from("sales_journeys")
      .select("rep_id, state, confirmed_at, commission_amount_cents")
      .not("confirmed_at", "is", null),
  ]);

  const firstError = repsRes.error ?? callsRes.error ?? messagesRes.error ?? journeysRes.error;
  if (firstError) {
    console.error("scoreboard query failed", firstError);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  const timeZone = envOptional("APP_TIMEZONE") ?? "America/Los_Angeles";
  return NextResponse.json(
    buildScoreboard(
      repsRes.data ?? [],
      (callsRes.data ?? []) as any,
      (messagesRes.data ?? []) as any,
      journeysRes.data ?? [],
      timeZone,
      new Date(),
      custom
    )
  );
}
