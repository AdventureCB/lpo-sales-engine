import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { syncPipelinesAndStages, upsertContact, upsertDeal } from "@/lib/crm-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

const V1 = "https://api.pipedrive.com/v1";
const V2 = "https://api.pipedrive.com/api/v2";
const PAGES_PER_RUN = 8; // 500 rows/page — resumable, budget-friendly

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
      for (let i = 0; i < PAGES_PER_RUN; i++) {
        const url = `${V2}/persons?limit=500${state.cursor ? `&cursor=${state.cursor}` : ""}`;
        const page = await pdGet(url);
        for (const p of page.data ?? []) await upsertContact(db, p);
        bump("persons", (page.data ?? []).length);
        state.cursor = page.additional_data?.next_cursor ?? null;
        if (!state.cursor) {
          state.phase = "deals";
          break;
        }
      }
    } else if (state.phase === "deals") {
      for (let i = 0; i < PAGES_PER_RUN; i++) {
        const url = `${V2}/deals?limit=500${state.cursor ? `&cursor=${state.cursor}` : ""}`;
        const page = await pdGet(url);
        for (const d of page.data ?? []) await upsertDeal(db, d);
        bump("deals", (page.data ?? []).length);
        state.cursor = page.additional_data?.next_cursor ?? null;
        if (!state.cursor) {
          state.phase = "done";
          break;
        }
      }
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
