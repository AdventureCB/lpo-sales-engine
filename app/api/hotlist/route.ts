import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { DEFAULT_RULES } from "@/lib/hotlist";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hot-list dashboard data: tiles, active flags, recent signal feed, rules.
 * Sales users see only deals they own; admin sees everything.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ownerFilter = user.role === "sales" ? user.pipedriveUserId : null;

  const db = supabaseAdmin();
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 3600_000).toISOString();

  let flagsQuery = db
    .from("hot_flags")
    .select("id, deal_id, reason, signals, deal_title, owner_name, person_phone, flagged_at, cleared_at, cooldown_until")
    .order("flagged_at", { ascending: false })
    .limit(50);
  if (ownerFilter) flagsQuery = flagsQuery.eq("owner_pipedrive_id", ownerFilter);

  const [flagsRes, signals24Res, configRes] = await Promise.all([
    flagsQuery,
    db
      .from("engagement_events")
      .select("id", { count: "exact", head: true })
      .gte("occurred_at", dayAgo),
    db.from("app_config").select("hot_rules").single(),
  ]);

  // Feed: sales users see signals on their flagged deals only; admin sees all.
  let feedQuery = db
    .from("engagement_events")
    .select("source, type, person_email, pipedrive_deal_id, occurred_at, meta")
    .order("occurred_at", { ascending: false })
    .limit(25);
  if (ownerFilter) {
    const dealIds = (flagsRes.data ?? []).map((f) => f.deal_id);
    feedQuery = feedQuery.in("pipedrive_deal_id", dealIds.length ? dealIds : [-1]);
  }
  const feedRes = await feedQuery;

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
