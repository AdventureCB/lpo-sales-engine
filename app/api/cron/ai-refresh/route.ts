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

  // ── mode=reviews: auto-review every call ≥5min (Kyle 9/9 — reviews are the
  // leading KPI, so they can't depend on the rep pressing the button). Newest
  // first; the review cache makes re-entry free; reviewCall re-checks budget.
  if (new URL(req.url).searchParams.get("mode") === "reviews") {
    const started = Date.now();
    const { reviewCall } = await import("@/lib/ai-call-review");
    const { data: calls } = await db
      .from("call_events")
      .select("quo_call_id, crm_deal_id, deal_id, duration_s, transcript:raw->>transcript")
      .gte("duration_s", 300)
      .gte("started_at", new Date(Date.now() - 14 * 86_400_000).toISOString())
      .not("raw->>transcript", "is", null)
      .order("started_at", { ascending: false })
      .limit(25);
    const candidates = (calls ?? []).filter((c: any) => String(c.transcript ?? "").length >= 400);
    let reviewed = 0;
    let skipped = 0;
    for (const c of candidates) {
      if (reviewed >= 3 || Date.now() - started > 40_000) break;
      const { data: existing } = await db
        .from("call_reviews")
        .select("id")
        .eq("quo_call_id", c.quo_call_id)
        .maybeSingle();
      if (existing) continue;
      // Resolve the deal: native uuid first, else the numeric internal id.
      let dealId: string | null = c.crm_deal_id;
      if (!dealId && c.deal_id) {
        const { data: d } = await db.from("crm_deals").select("id").eq("pipedrive_deal_id", c.deal_id).maybeSingle();
        dealId = d?.id ?? null;
      }
      if (!dealId) continue;
      const res = await reviewCall(db, { dealId, quoCallId: c.quo_call_id });
      if (res.ok && !res.cached) reviewed++;
      else if (!res.ok) {
        skipped++;
        if ((res.reason ?? "").includes("budget")) break;
      }
    }
    return NextResponse.json({ mode: "reviews", eligible: candidates.length, reviewed, skipped });
  }

  const { data: cands } = await db.rpc("ai_refresh_candidates", {
    p_limit: PER_RUN,
    p_since_days: 7,
    // Scope at the query so out-of-scope deals never occupy candidate slots.
    p_pipelines: cfg.pipelines.length ? cfg.pipelines : null,
  });
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
