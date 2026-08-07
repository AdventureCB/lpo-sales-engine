import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { generateAndSave, loadConfig } from "@/lib/sprint-lists";
import { sweepExpiredCheckouts } from "@/lib/reprospect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function laToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Daily 1pm-PT job: release lapsed reprospecting holds back to the pool, then
 * auto-generate List 3 (carryover + stale + reprospect) for every active rep.
 * ?slot=1|2 also supported (e.g. a morning pre-gen), default slot 3.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const slot = (Number(new URL(req.url).searchParams.get("slot")) || 3) as 1 | 2 | 3;
  const db = supabaseAdmin();
  const cfg = await loadConfig(db);
  const forDate = laToday();

  // Expired 3-day holds must release before generation so they re-pool.
  const released = slot === 3 ? await sweepExpiredCheckouts(db) : 0;

  const { data: reps } = await db
    .from("reps")
    .select("email, pipedrive_user_id")
    .eq("active", true)
    .not("pipedrive_user_id", "is", null);

  const results: any[] = [];
  for (const r of reps ?? []) {
    try {
      const out = await generateAndSave(
        db,
        { repEmail: r.email!, repPipedriveId: r.pipedrive_user_id!, slot, forDate },
        cfg
      );
      results.push({ rep: r.email, count: out.count });
    } catch (e) {
      results.push({ rep: r.email, error: e instanceof Error ? e.message : "failed" });
    }
  }

  return NextResponse.json({ ok: true, slot, forDate, releasedCheckouts: released, results });
}
