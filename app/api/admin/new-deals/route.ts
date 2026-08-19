import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Admin-only: new-deal counts bucketed by day/week/month + per-source, LA-local inclusive range. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const start = p.get("start") ?? "";
  const end = p.get("end") ?? "";
  const bucket = ["day", "week", "month"].includes(p.get("bucket") ?? "") ? p.get("bucket")! : "day";
  if (!DATE.test(start) || !DATE.test(end) || start > end) {
    return NextResponse.json({ error: "start/end (YYYY-MM-DD, start ≤ end) required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin().rpc("new_deals_report", {
    p_start: start,
    p_end: end,
    p_bucket: bucket,
  });
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ start, end, bucket, ...data });
}
