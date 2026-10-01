import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { getMetricIds, pageEventsForMetric } from "@/lib/klaviyo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STATE_KEY = "klaviyo_engagement_backfill";
const DEADLINE_MS = 48_000;
// Clicks first (small, the strong attribution signal), then opens (~40k/month).
const PHASES: Array<{ phase: "click" | "open"; metric: string; type: string }> = [
  { phase: "click", metric: "Clicked Email", type: "email_click" },
  { phase: "open", metric: "Opened Email", type: "email_open" },
];

interface State {
  from: string;
  to: string;
  phase: "click" | "open" | "done";
  next: string | null;
  inserted: number;
  pages: number;
  startedAt: string;
  finishedAt?: string;
}

/**
 * Historical Klaviyo opens/clicks into engagement_events (source klaviyo), for
 * the Revenue page's Klaviyo attribution. Resumable: the Klaviyo `next` cursor
 * is kept in crm_sync_state between runs. Rows are plain upserts — nothing
 * here feeds automations or the hot list.
 *   ?from=YYYY-MM-DD (default 2025-09-01)  ?to=YYYY-MM-DD (default 2026-07-20,
 *   where live ingestion begins)  ?reset=1 restarts.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const url = new URL(req.url);
  const started = Date.now();

  const { data: st } = await db.from("crm_sync_state").select("value").eq("key", STATE_KEY).maybeSingle();
  let state = (url.searchParams.get("reset") === "1" ? null : (st?.value as State | null)) ?? null;
  if (!state) {
    state = {
      from: `${url.searchParams.get("from") ?? "2025-09-01"}T00:00:00Z`,
      to: `${url.searchParams.get("to") ?? "2026-07-20"}T00:00:00Z`,
      phase: "click",
      next: null,
      inserted: 0,
      pages: 0,
      startedAt: new Date().toISOString(),
    };
  }
  if (state.phase === "done") return NextResponse.json({ ok: true, done: true, ...state });

  const metricIds = await getMetricIds();
  let runInserted = 0;
  let runPages = 0;
  try {
    while (Date.now() - started < DEADLINE_MS && state.phase !== "done") {
      const cfg = PHASES.find((p) => p.phase === state!.phase)!;
      const metricId = metricIds.get(cfg.metric);
      if (!metricId) throw new Error(`Klaviyo metric not found: ${cfg.metric}`);
      const { events, next } = await pageEventsForMetric(state.next, metricId, state.from, state.to);
      if (events.length) {
        const rows = events.map((e) => ({ source: "klaviyo", type: cfg.type, person_email: e.email, occurred_at: e.occurredAt, meta: e.meta }));
        const { error } = await db.from("engagement_events").upsert(rows, { onConflict: "source,type,person_email,occurred_at", ignoreDuplicates: true });
        if (error) throw new Error(error.message);
        runInserted += rows.length;
      }
      runPages++;
      state.pages++;
      state.inserted += events.length;
      if (next) {
        state.next = next;
      } else {
        const idx = PHASES.findIndex((p) => p.phase === state!.phase);
        const following = PHASES[idx + 1];
        state.phase = following ? following.phase : "done";
        state.next = null;
        if (state.phase === "done") state.finishedAt = new Date().toISOString();
      }
    }
  } finally {
    await db.from("crm_sync_state").upsert({ key: STATE_KEY, value: state, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }
  return NextResponse.json({ ok: true, done: state.phase === "done", phase: state.phase, runInserted, runPages, totalInserted: state.inserted, totalPages: state.pages });
}
