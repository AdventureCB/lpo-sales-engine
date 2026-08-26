import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { buildFeatureChunk, runHypothesisGeneration, scoreProspective } from "@/lib/ai-hypotheses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Hypothesis engine driver.
 *  ?mode=features&offset=N — build/refresh the closed-deal feature snapshot
 *    (chunked; returns nextOffset until done)
 *  ?mode=generate — one model call: propose → backtest → register/reject
 *  ?mode=score — zero-token prospective scoring of registered hypotheses
 *    against newly closed deals (this is the nightly cadence)
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url);
  const mode = u.searchParams.get("mode") ?? "score";
  const db = supabaseAdmin();
  const started = Date.now();

  if (mode === "features") {
    let offset = Number(u.searchParams.get("offset") ?? 0);
    let total = 0;
    while (Date.now() - started < 45_000) {
      const r = await buildFeatureChunk(db, offset);
      total = r.total;
      offset += r.processed;
      if (r.processed === 0 || offset >= r.total) {
        return NextResponse.json({ ok: true, mode, done: true, processed: offset, total });
      }
    }
    return NextResponse.json({ ok: true, mode, done: false, nextOffset: offset, total });
  }

  if (mode === "generate") {
    const r = await runHypothesisGeneration(db);
    return NextResponse.json({ ok: true, mode, ...r });
  }

  // score: fold newly closed deals into the snapshot first (universe is
  // ordered by close time, so the row count is an incremental cursor; the
  // small overlap just re-upserts), then update every registered hypothesis.
  if (mode === "score") {
    const { count } = await db.from("ai_deal_features").select("deal_id", { count: "exact", head: true });
    await buildFeatureChunk(db, Math.max(0, (count ?? 0) - 20));
    const r = await scoreProspective(db);
    return NextResponse.json({ ok: true, mode, ...r });
  }

  return NextResponse.json({ error: "unknown mode" }, { status: 400 });
}
