import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { loadAiConfig, monthToDateSpendCents } from "@/lib/ai-profiler";
import { extractProfile } from "@/lib/ai-profiler-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PER_RUN = 15; // bounded so a run stays well under the timeout + budget

/**
 * Phase 2 — background profile refresh. Finds open deals with a call
 * transcript newer than their last profile run (or never profiled) and
 * re-extracts incrementally, so a profile is current before a rep opens the
 * deal. Only runs when the profiler is enabled AND not lazy-only; the engine
 * re-checks scope/debounce/budget per deal and no-ops for free when nothing
 * is due. Stops early once the monthly budget is hit.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const cfg = await loadAiConfig(db);
  if (!cfg.enabled || cfg.lazy_only) return NextResponse.json({ skipped: "background refresh off" });

  if ((await monthToDateSpendCents(db)) >= cfg.monthly_budget_cents)
    return NextResponse.json({ skipped: "monthly budget reached" });

  const { data: cands } = await db.rpc("ai_refresh_candidates", { p_limit: PER_RUN, p_since_days: 7 });
  let refreshed = 0;
  let skipped = 0;
  let budgetHit = false;
  for (const c of (cands ?? []) as { deal_id: string }[]) {
    const res = await extractProfile(db, c.deal_id, {}); // non-force: full guards apply
    if (res.ran) refreshed++;
    else {
      skipped++;
      if ((res.reason ?? "").includes("budget")) {
        budgetHit = true;
        break;
      }
    }
  }
  return NextResponse.json({ candidates: (cands ?? []).length, refreshed, skipped, budgetHit });
}
