import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { DEFAULT_RULES } from "@/lib/hotlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hot-list dashboard data: tiles, active flags, recent signal feed, rules. */
export async function GET() {
  const db = supabaseAdmin();
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 3600_000).toISOString();

  const [flagsRes, signals24Res, feedRes, configRes] = await Promise.all([
    db
      .from("hot_flags")
      .select("id, deal_id, reason, signals, deal_title, owner_name, flagged_at, cleared_at, cooldown_until")
      .order("flagged_at", { ascending: false })
      .limit(50),
    db
      .from("engagement_events")
      .select("id", { count: "exact", head: true })
      .gte("occurred_at", dayAgo),
    db
      .from("engagement_events")
      .select("source, type, person_email, pipedrive_deal_id, occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(25),
    db.from("app_config").select("hot_rules").single(),
  ]);

  const error = flagsRes.error ?? feedRes.error ?? configRes.error;
  if (error) {
    console.error("hotlist query failed", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  const flags = flagsRes.data ?? [];
  const active = flags.filter((f) => !f.cleared_at);
  const newToday = flags.filter((f) => f.flagged_at >= dayAgo);

  return NextResponse.json({
    tiles: {
      flaggedNow: active.length,
      newToday: newToday.length,
      signals24h: signals24Res.count ?? 0,
    },
    flags,
    feed: feedRes.data ?? [],
    rules: { ...DEFAULT_RULES, ...((configRes.data?.hot_rules as object) ?? {}) },
  });
}
