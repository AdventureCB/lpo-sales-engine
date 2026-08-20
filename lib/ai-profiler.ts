import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * AI deal-profiler config + model routing + cost model. No API calls here —
 * this is the tunable policy the extraction engine reads. Scope toggles let
 * Kyle control exactly which deals the model looks at; lost/won are NEVER
 * eligible (hard rule, not a toggle).
 */

// Task → model tier. Bulk work runs on the cheap tier; the expensive tiers
// are reserved for on-demand deep dives and the rare taxonomy critic.
export type ModelTier = "haiku" | "sonnet" | "opus";
export const MODEL_IDS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
};

// Approx API price per MILLION tokens (USD). Used only to estimate/record
// cost_cents; the source of truth for spend is summed ai_usage rows.
export const PRICE_PER_MTOK: Record<ModelTier, { in: number; out: number; cacheRead: number }> = {
  haiku: { in: 1, out: 5, cacheRead: 0.1 },
  sonnet: { in: 3, out: 15, cacheRead: 0.3 },
  opus: { in: 15, out: 75, cacheRead: 1.5 },
};

export function estimateCostCents(
  tier: ModelTier,
  tokensIn: number,
  tokensOut: number,
  cacheReadTokens = 0
): number {
  const p = PRICE_PER_MTOK[tier];
  const dollars =
    ((tokensIn - cacheReadTokens) * p.in + cacheReadTokens * p.cacheRead + tokensOut * p.out) / 1_000_000;
  return dollars * 100;
}

export type AiProfilerConfig = {
  enabled: boolean;
  // Scope — which OPEN deals are eligible (lost/won always excluded in code).
  pipelines: string[]; // pipeline names to include; [] = all active pipelines
  require_transcript: boolean; // only profile deals with real call material (cost control)
  active_days: number; // only deals with activity within N days (0 = ignore)
  min_value_cents: number | null;
  // Cost governance
  debounce_hours: number; // don't re-run a deal more often than this
  monthly_budget_cents: number; // soft cap; engine pauses new runs past it
  lazy_only: boolean; // true = only profile a deal when opened/requested (no backfill sweep)
  // Model routing per task
  models: { extract: ModelTier; revalidate: ModelTier; deepdive: ModelTier; critic: ModelTier; call_script: ModelTier; drafts: ModelTier; review: ModelTier };
};

export const DEFAULT_AI_CONFIG: AiProfilerConfig = {
  enabled: false, // off until an ANTHROPIC_API_KEY is set and Kyle flips it on
  pipelines: [], // all active pipelines
  require_transcript: true,
  active_days: 30,
  min_value_cents: null,
  debounce_hours: 24,
  monthly_budget_cents: 2000, // $20/mo soft cap
  lazy_only: true, // profile on deal-open; no upfront backfill burn
  // call_script runs per dial-cycle preload → cheap tier; drafts are
  // customer-facing prose on manual request → quality tier.
  models: { extract: "haiku", revalidate: "haiku", deepdive: "sonnet", critic: "sonnet", call_script: "haiku", drafts: "sonnet", review: "sonnet" },
};

const CONFIG_KEY = "ai_profiler_config";

export async function loadAiConfig(db: SupabaseClient): Promise<AiProfilerConfig> {
  const { data } = await db.from("crm_sync_state").select("value").eq("key", CONFIG_KEY).maybeSingle();
  const c = (data?.value ?? {}) as Partial<AiProfilerConfig>;
  return { ...DEFAULT_AI_CONFIG, ...c, models: { ...DEFAULT_AI_CONFIG.models, ...(c.models ?? {}) } };
}

export async function saveAiConfig(db: SupabaseClient, patch: Partial<AiProfilerConfig>): Promise<AiProfilerConfig> {
  const merged = { ...(await loadAiConfig(db)), ...patch };
  await db
    .from("crm_sync_state")
    .upsert({ key: CONFIG_KEY, value: merged, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return merged;
}

/** Month-to-date AI spend in cents (source of truth for the budget). */
export async function monthToDateSpendCents(db: SupabaseClient): Promise<number> {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const { data } = await db.from("ai_usage").select("cost_cents").gte("created_at", since.toISOString());
  return (data ?? []).reduce((a, r) => a + Number(r.cost_cents ?? 0), 0);
}
