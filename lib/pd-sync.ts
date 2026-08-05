import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { envOptional } from "./env";
import {
  PipedriveRateLimitError,
  getDeal,
  getRecentPersonActivities,
  updateActivity,
  addDealNote,
  createActivity,
  updateDealStage,
  updatePersonContacts,
} from "./pipedrive";

/**
 * Pipedrive outbox. CRM writes are the source of truth and land first;
 * these jobs replay them into Pipedrive whenever API budget allows. The
 * processor stops cleanly on the daily rate limit (jobs stay pending) and
 * shelves jobs as 'error' after repeated non-rate-limit failures.
 */

const MAX_ATTEMPTS = 5;

export type PdSyncKind =
  | "disposition"
  | "note"
  | "activity_create"
  | "activity_done"
  | "deal_update"
  | "person_update";

export async function enqueuePdSync(
  db: SupabaseClient,
  kind: PdSyncKind,
  payload: Record<string, unknown>
): Promise<void> {
  if (!envOptional("PIPEDRIVE_API_TOKEN")) return; // post-cutover: no-op
  const { error } = await db.from("pd_sync_queue").insert({ kind, payload });
  if (error) console.error(`pd-sync enqueue ${kind} failed`, error.message);
}

const DISPO_LABELS: Record<string, string> = {
  connected: "✅ Connected",
  vm_dropped: "🎙 Voicemail left",
  bad_number: "🚫 Bad number",
  callback: "📅 Callback scheduled",
};

/** Link the Quo-logged call activity to the deal + stamp the disposition. */
async function runDisposition(p: any): Promise<void> {
  const label = DISPO_LABELS[p.disposition] ?? p.disposition;
  const deal = await getDeal(p.dealId);
  const windowStart = Date.parse(p.dialStartedAt) - 2 * 60_000;
  if (deal.person_id) {
    const activities = await getRecentPersonActivities(deal.person_id);
    const callActivity = activities.find(
      (a) =>
        a.type === "call" &&
        a.add_time &&
        Date.parse(`${a.add_time.replace(" ", "T")}Z`) >= windowStart
    );
    if (callActivity) {
      const dispoLine = `Queue Runner disposition: ${label}`;
      await updateActivity(callActivity.id, {
        deal_id: p.dealId,
        note: callActivity.note ? `${callActivity.note}<br>${dispoLine}` : dispoLine,
      });
      return;
    }
  }
  await addDealNote(p.dealId, `📞 Dial attempt — ${label} (via Queue Runner)`);
}

async function runJob(db: SupabaseClient, kind: string, p: any): Promise<void> {
  switch (kind) {
    case "disposition":
      return runDisposition(p);
    case "note":
      return addDealNote(p.dealId, p.content);
    case "activity_create": {
      const pdId = await createActivity({
        dealId: p.dealId,
        subject: p.subject,
        type: p.type,
        dueAtIso: p.dueAtIso ?? null,
      });
      if (pdId && p.crmActivityId) {
        await db
          .from("crm_activities")
          .update({ pipedrive_activity_id: pdId })
          .eq("id", p.crmActivityId);
      }
      return;
    }
    case "activity_done":
      return updateActivity(p.pipedriveActivityId, { done: 1 });
    case "deal_update":
      return updateDealStage(p.dealId, p.fields ?? {});
    case "person_update":
      return updatePersonContacts(p.personId, { phones: p.phones, emails: p.emails });
    default:
      throw new Error(`unknown pd-sync kind: ${kind}`);
  }
}

export interface PdSyncResult {
  processed: number;
  failed: number;
  pending: number;
  rateLimited: boolean;
}

export async function processPdSyncQueue(
  db: SupabaseClient,
  budgetMs: number
): Promise<PdSyncResult> {
  const started = Date.now();
  let processed = 0;
  let failed = 0;
  let rateLimited = false;

  if (envOptional("PIPEDRIVE_API_TOKEN")) {
    const { data: jobs } = await db
      .from("pd_sync_queue")
      .select("id, kind, payload, attempts")
      .eq("status", "pending")
      .order("created_at")
      .limit(200);

    for (const job of jobs ?? []) {
      if (Date.now() - started >= budgetMs) break;
      try {
        await runJob(db, job.kind, job.payload);
        await db
          .from("pd_sync_queue")
          .update({ status: "done", processed_at: new Date().toISOString() })
          .eq("id", job.id);
        processed++;
      } catch (e) {
        if (e instanceof PipedriveRateLimitError) {
          rateLimited = true;
          break; // budget exhausted — everything left stays pending
        }
        const attempts = (job.attempts ?? 0) + 1;
        await db
          .from("pd_sync_queue")
          .update({
            attempts,
            last_error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
            status: attempts >= MAX_ATTEMPTS ? "error" : "pending",
          })
          .eq("id", job.id);
        failed++;
      }
    }
  }

  const { count } = await db
    .from("pd_sync_queue")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");
  return { processed, failed, pending: count ?? 0, rateLimited };
}
