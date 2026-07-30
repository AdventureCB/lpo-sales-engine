import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import {
  syncPipelinesAndStages,
  upsertContactsBatch,
  upsertDealsBatch,
  upsertNotesBatch,
  upsertActivitiesBatch,
  upsertDealFlowBatch,
} from "@/lib/crm-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

const V1 = "https://api.pipedrive.com/v1";
const V2 = "https://api.pipedrive.com/api/v2";
const PAGES_PER_RUN = 8; // 500 rows/page — resumable, budget-friendly
const BUDGET_MS = 40_000; // return well before Vercel's 60s kill

async function pdGet(url: string): Promise<any> {
  const u = new URL(url);
  u.searchParams.set("api_token", env("PIPEDRIVE_API_TOKEN"));
  const res = await fetch(u);
  const json = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error("rate_limited");
  if (!res.ok || json.success === false) {
    throw new Error(`Pipedrive ${res.status}: ${JSON.stringify(json.error ?? {}).slice(0, 200)}`);
  }
  return json;
}

/**
 * Resumable Pipedrive → CRM backfill. Admin-triggered; each call imports a
 * bounded chunk and stores its cursor, so repeated calls (or a cron) walk
 * the whole account: pipelines/stages → persons → deals. Webhooks keep the
 * mirror fresh from there.
 */
export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const db = supabaseAdmin();
  const { data: stateRow } = await db
    .from("crm_sync_state")
    .select("value")
    .eq("key", "import")
    .maybeSingle();
  const state: { phase: string; cursor: string | null; counts: Record<string, number> } =
    (stateRow?.value as any) ?? { phase: "pipelines", cursor: null, counts: {} };

  const bump = (k: string, n: number) => (state.counts[k] = (state.counts[k] ?? 0) + n);
  // Imports finished before later phases existed resume at the missing one.
  if (state.phase === "done" && !("notes" in state.counts)) {
    state.phase = "notes";
    state.cursor = null;
  }
  if (state.phase === "done" && !("history" in state.counts)) {
    state.phase = "history";
    state.cursor = null;
  }
  const started = Date.now();
  // Persist the cursor after every page so a hard kill loses at most one
  // (idempotent) page — without this, a timeout retries the same chunk forever.
  const saveState = () =>
    db.from("crm_sync_state").upsert({ key: "import", value: state }, { onConflict: "key" });

  try {
    if (state.phase === "pipelines") {
      const [pipelines, stages] = await Promise.all([
        pdGet(`${V1}/pipelines`),
        pdGet(`${V1}/stages?limit=500`),
      ]);
      await syncPipelinesAndStages(db, pipelines.data ?? [], stages.data ?? []);
      bump("pipelines", (pipelines.data ?? []).length);
      bump("stages", (stages.data ?? []).length);
      state.phase = "persons";
      state.cursor = null;
    } else if (state.phase === "persons") {
      for (let i = 0; i < PAGES_PER_RUN && Date.now() - started < BUDGET_MS; i++) {
        const url = `${V2}/persons?limit=500${state.cursor ? `&cursor=${state.cursor}` : ""}`;
        const page = await pdGet(url);
        await upsertContactsBatch(db, page.data ?? []);
        bump("persons", (page.data ?? []).length);
        state.cursor = page.additional_data?.next_cursor ?? null;
        if (!state.cursor) state.phase = "deals";
        await saveState();
        if (!state.cursor) break;
      }
    } else if (state.phase === "deals") {
      for (let i = 0; i < PAGES_PER_RUN && Date.now() - started < BUDGET_MS; i++) {
        const url = `${V2}/deals?limit=500${state.cursor ? `&cursor=${state.cursor}` : ""}`;
        const page = await pdGet(url);
        await upsertDealsBatch(db, page.data ?? []);
        bump("deals", (page.data ?? []).length);
        state.cursor = page.additional_data?.next_cursor ?? null;
        if (!state.cursor) state.phase = "notes";
        await saveState();
        if (!state.cursor) break;
      }
    } else if (state.phase === "notes") {
      // v1 endpoint — start/limit pagination instead of cursors.
      for (let i = 0; i < PAGES_PER_RUN && Date.now() - started < BUDGET_MS; i++) {
        const start = state.cursor ? Number(state.cursor) : 0;
        const page = await pdGet(`${V1}/notes?limit=500&start=${start}`);
        await upsertNotesBatch(db, page.data ?? []);
        bump("notes", (page.data ?? []).length);
        const pag = page.additional_data?.pagination;
        state.cursor = pag?.more_items_in_collection ? String(pag.next_start) : null;
        if (!state.cursor) state.phase = "activities";
        await saveState();
        if (!state.cursor) break;
      }
    } else if (state.phase === "activities") {
      for (let i = 0; i < PAGES_PER_RUN && Date.now() - started < BUDGET_MS; i++) {
        const url = `${V2}/activities?limit=500${state.cursor ? `&cursor=${state.cursor}` : ""}`;
        const page = await pdGet(url);
        await upsertActivitiesBatch(db, page.data ?? []);
        bump("activities", (page.data ?? []).length);
        state.cursor = page.additional_data?.next_cursor ?? null;
        if (!state.cursor) state.phase = "history";
        await saveState();
        if (!state.cursor) break;
      }
    } else if (state.phase === "history") {
      // Per-deal flow feed: synced emails + deal change log — the layers the
      // bulk endpoints don't expose. One call per deal, newest deals first,
      // cursor = last processed pipedrive_deal_id (descending).
      const { data: stageRows } = await db.from("crm_stages").select("pipedrive_stage_id, name");
      const stageNames = new Map((stageRows ?? []).map((s) => [s.pipedrive_stage_id, s.name]));
      const below = state.cursor ? Number(state.cursor) : Number.MAX_SAFE_INTEGER;
      const { data: dealsChunk, error: dcErr } = await db
        .from("crm_deals")
        .select("id, pipedrive_deal_id, contact_id")
        .lt("pipedrive_deal_id", below)
        .not("pipedrive_deal_id", "is", null)
        .order("pipedrive_deal_id", { ascending: false })
        .limit(500);
      if (dcErr) throw new Error(dcErr.message);
      if (!dealsChunk || dealsChunk.length === 0) {
        state.phase = "done";
        await db.rpc("refresh_deal_last_activity");
      } else {
        let processed = 0;
        for (const deal of dealsChunk) {
          if (Date.now() - started >= BUDGET_MS) break;
          const items: any[] = [];
          let start = 0;
          for (let p = 0; p < 3; p++) {
            const page = await pdGet(`${V1}/deals/${deal.pipedrive_deal_id}/flow?limit=100&start=${start}`);
            items.push(...(page.data ?? []));
            const pag = page.additional_data?.pagination;
            if (!pag?.more_items_in_collection) break;
            start = pag.next_start;
          }
          const n = await upsertDealFlowBatch(db, deal, items, stageNames);
          bump("emails", n.emails);
          bump("changes", n.changes);
          state.cursor = String(deal.pipedrive_deal_id);
          processed++;
          if (processed % 20 === 0) await saveState();
        }
        bump("history", processed);
      }
      await saveState();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .from("crm_sync_state")
      .upsert({ key: "import", value: state }, { onConflict: "key" });
    if (msg === "rate_limited") {
      return NextResponse.json({ ok: false, state, error: "Pipedrive daily budget exhausted — try later" }, { status: 429 });
    }
    return NextResponse.json({ ok: false, state, error: msg }, { status: 500 });
  }

  await db.from("crm_sync_state").upsert({ key: "import", value: state }, { onConflict: "key" });
  return NextResponse.json({ ok: true, state, done: state.phase === "done" });
}
