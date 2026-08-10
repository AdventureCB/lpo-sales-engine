import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { computeEngagement, laToday } from "@/lib/engagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Admin-only engagement readout: one PT day + a 7-day engaged trend. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const params = new URL(req.url).searchParams;
  const date = params.get("date") ?? laToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "bad date" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: cfgRow } = await db.from("rep_activity_config").select("config").eq("id", true).maybeSingle();
  const kpiHours = Number((cfgRow?.config as any)?.kpi_hours ?? 4);

  const reps = await computeEngagement(db, date);

  // 7-day engaged trend ending on the requested date (skip if trend=0).
  const trend: { date: string; byRep: Record<string, number> }[] = [];
  if (params.get("trend") !== "0") {
    const base = new Date(`${date}T12:00:00Z`);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(base.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      if (d === date) {
        trend.push({ date: d, byRep: Object.fromEntries(reps.map((r) => [r.email, r.engagedS])) });
      } else {
        const day = await computeEngagement(db, d);
        trend.push({ date: d, byRep: Object.fromEntries(day.map((r) => [r.email, r.engagedS])) });
      }
    }
  }

  return NextResponse.json({ date, kpiHours, reps, trend });
}
