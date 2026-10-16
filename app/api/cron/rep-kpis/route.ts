import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { computeRepKpis, computeWeekly } from "@/lib/rep-kpis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Hourly (pg_cron 38): snapshot every rep's KPIs for the four windows + the 12-week series. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const started = Date.now();
  const out: Record<string, number> = {};
  const weeklyCache = new Map<string, any[]>();
  for (const days of [7, 14, 30, 90]) {
    const res = await computeRepKpis(db, days);
    const rows = [];
    for (const r of res.reps) {
      const key = r.email.toLowerCase();
      if (!weeklyCache.has(key)) weeklyCache.set(key, await computeWeekly(db, r.email));
      rows.push({ days, rep_email: key, computed_at: res.computedAt, payload: r, weekly: weeklyCache.get(key) });
    }
    if (rows.length) {
      const { error } = await db.from("rep_kpi_snapshots").upsert(rows, { onConflict: "days,rep_email" });
      if (error) return NextResponse.json({ error: error.message, days }, { status: 500 });
    }
    out[`d${days}`] = rows.length;
  }
  return NextResponse.json({ ok: true, ...out, ms: Date.now() - started });
}
