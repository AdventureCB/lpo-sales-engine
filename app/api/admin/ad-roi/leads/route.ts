import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 3000;

/**
 * Admin: the deals behind the Ad ROI lead-contact funnel cards.
 * ?scope=all|new &days= &excludeHotlist=1 — same definitions as the cards
 * (attempt = first outbound dial, contact = first real conversation).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const params = new URL(req.url).searchParams;
  const days = Math.min(Math.max(Number(params.get("days") ?? 30) || 30, 7), 180);
  const scope = params.get("scope") === "all" ? "all" : "new";
  const excludeHotlist = params.get("excludeHotlist") === "1";
  const { data, error } = await supabaseAdmin().rpc("lead_contact_funnel_deals", {
    p_days: days,
    p_exclude_hotlist: excludeHotlist,
    p_scope: scope,
    p_limit: LIMIT,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as any[];
  return NextResponse.json({
    scope,
    days,
    limit: LIMIT,
    truncated: rows.length >= LIMIT,
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      status: r.status,
      stage: r.stage,
      source: r.source,
      owner: r.owner,
      contactName: r.contact_name,
      hasPhone: !!r.has_phone,
      attemptAt: r.attempt_at,
      contactAt: r.contact_at,
    })),
  });
}
