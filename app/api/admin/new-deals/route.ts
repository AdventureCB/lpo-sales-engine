import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Admin-only deal flow: new/won/lost per day|week|month bucket (LA-local
 * inclusive range), optional source filter, totals (incl. current open
 * snapshot) + per-source births + the source catalog for the filter UI.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const start = p.get("start") ?? "";
  const end = p.get("end") ?? "";
  const bucket = ["day", "week", "month"].includes(p.get("bucket") ?? "") ? p.get("bucket")! : "day";
  const source = p.get("source")?.trim() || null;
  if (!DATE.test(start) || !DATE.test(end) || start > end) {
    return NextResponse.json({ error: "start/end (YYYY-MM-DD, start ≤ end) required" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const [{ data, error }, { data: sourceRows }] = await Promise.all([
    db.rpc("deal_flow_report", { p_start: start, p_end: end, p_bucket: bucket, p_source: source }),
    db.from("deal_sources").select("name").order("sort_order").order("name"),
  ]);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({
    start,
    end,
    bucket,
    source,
    sources: (sourceRows ?? []).map((s: any) => s.name),
    ...data,
  });
}
