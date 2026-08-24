import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { computeLeadCost } from "@/lib/lead-cost";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Admin-only ad ROI: per-channel spend / leads / CPL / won value + blended CAC. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days") ?? 30) || 30, 7), 180);
  const db = supabaseAdmin();
  const report = await computeLeadCost(db, days);

  // First-party beacon freshness — the pipeline is fail-silent by design, so
  // this line is how a dead beacon gets noticed (it once 401'd for 2 weeks).
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [{ data: lastTouch }, { count: touches24h }, { count: links }] = await Promise.all([
    db.from("web_touches").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("web_touches").select("id", { count: "exact", head: true }).gte("created_at", dayAgo),
    db.from("web_visitor_links").select("visitor_id", { count: "exact", head: true }),
  ]);
  return NextResponse.json({
    ...report,
    beacon: { lastAt: lastTouch?.created_at ?? null, touches24h: touches24h ?? 0, linkedVisitors: links ?? 0 },
  });
}
