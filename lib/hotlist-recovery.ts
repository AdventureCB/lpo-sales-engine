import type { SupabaseClient } from "@supabase/supabase-js";
import { processIntake, type IntakeSource } from "./intake";

/**
 * Hot List Import — create/reopen deals for contacts whose recent marketing
 * signals qualify (buy-intent OR click OR ≥2 signal types) but who have no
 * OPEN deal. Runs off the CRM mirror only; delegates the create/reopen/notify
 * logic to processIntake so it inherits the shared intake behavior.
 *   - no deal at all      → new deal, Cainen-owned (reprospect-pool ranked)
 *   - closed deal exists  → reopen to previous owner, moved to Hot List Import
 * Idempotent per contact per ISO week (a re-engaging contact re-enters weekly;
 * an already-open deal is skipped by the engine's on_existing_open=skip).
 */
export async function runHotlistRecovery(
  db: SupabaseClient,
  opts?: { limit?: number; deadline?: number }
): Promise<Record<string, unknown>> {
  const { data: src } = await db
    .from("intake_sources")
    .select("id, channel_id, label, adapter, enabled, config")
    .eq("adapter", "hotlist_recovery")
    .maybeSingle();
  if (!src) return { skipped: "no hotlist_recovery source" };
  if (!src.enabled) return { skipped: "disabled" };

  const source = src as IntakeSource;
  const rec = source.config.recovery ?? {};
  const windowDays = rec.window_days ?? 7;
  const perSweep = Math.min(opts?.limit ?? rec.per_sweep ?? 25, 100);
  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const { data: candidates, error } = await db.rpc("hotlist_recovery_candidates", {
    p_window_start: windowStart,
    p_click_hours: rec.click_hours ?? 72,
    p_distinct_hours: rec.distinct_hours ?? 72,
    p_limit: perSweep,
  });
  if (error) throw new Error(error.message);

  const week = isoWeek(new Date());
  let created = 0,
    reopened = 0,
    skipped = 0,
    errors = 0;
  for (const c of (candidates ?? []) as Array<{
    person_email: string;
    latest_at: string;
    summary: string;
    buy_intent: number;
    clicks: number;
    distinct_types: number;
  }>) {
    if (opts?.deadline && Date.now() > opts.deadline) break;
    const r = await processIntake(db, source, {
      email: c.person_email,
      note: `Marketing signals (${windowDays}d): ${c.summary}`,
      occurredAt: c.latest_at,
      externalId: `recovery:${c.person_email}:${week}`,
      meta: {
        engine: "hotlist_recovery",
        buy_intent: c.buy_intent,
        clicks: c.clicks,
        distinct_types: c.distinct_types,
      },
    });
    if (r.action === "created") created++;
    else if (r.action === "reopened") reopened++;
    else if (r.action === "error") errors++;
    else skipped++;
  }
  return { candidates: candidates?.length ?? 0, created, reopened, skipped, errors };
}

/** ISO-week key (YYYY-Www) for weekly idempotency of recovery attempts. */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
