import "server-only";
import { supabaseAdmin } from "./supabase";
import { listOpenDealsByStage, getPersonsByIds, type DealListItem } from "./pipedrive";
import { normalizePhone } from "./identity";
import type { SessionUser } from "./auth";

/** Stage id → display name (from the live Pipedrive stage list). */
export const STAGE_NAMES: Record<number, string> = {
  44: "Intake- Needs Qualification",
  45: "Recovery",
  46: "Qualified",
  47: "Waiting on Timing",
  48: "Qualified",
  50: "Deposit Placed",
  51: "Deposit Placed",
  52: "Confirmation Scheduled",
  53: "Confirmed (Won)",
  54: "Cold",
  55: "Warm",
  56: "Hot",
};

export type OwnerScope = "mine" | "unassigned" | "both" | "anyone";

/**
 * Ownership rule: sales reps may work deals they own or deals not assigned
 * to any sales rep ("unassigned" = house/admin-owned). Admin sees anyone's.
 */
export function buildOwnerCheck(
  user: SessionUser,
  scope: OwnerScope,
  repPipedriveIds: Set<number>
): (deal: DealListItem) => boolean {
  const mine = (d: DealListItem) => d.owner_id === user.pipedriveUserId;
  const unassigned = (d: DealListItem) => !repPipedriveIds.has(d.owner_id);
  if (user.role === "admin") {
    if (scope === "mine") return mine;
    if (scope === "unassigned") return unassigned;
    return () => true;
  }
  // sales: "anyone" is not available — clamp to both
  if (scope === "mine") return mine;
  if (scope === "unassigned") return unassigned;
  return (d) => mine(d) || unassigned(d);
}

export interface QueueLead {
  dealId: number;
  title: string;
  personName: string | null;
  phone: string | null;
  stageId: number;
  stageName: string;
  ownerId: number;
  updateTime: string | null;
  hot: boolean;
  hotReason: string | null;
}

export async function buildQueueLeads(opts: {
  user: SessionUser;
  stageIds: number[];
  ownerScope: OwnerScope;
  nameContains?: string;
}): Promise<{ leads: QueueLead[]; skippedNoPhone: number }> {
  const db = supabaseAdmin();
  const { data: reps } = await db
    .from("reps")
    .select("pipedrive_user_id")
    .eq("active", true)
    .not("pipedrive_user_id", "is", null);
  const repIds = new Set((reps ?? []).map((r) => r.pipedrive_user_id as number));
  const allowed = buildOwnerCheck(opts.user, opts.ownerScope, repIds);

  const deals: DealListItem[] = [];
  for (const stageId of opts.stageIds) {
    deals.push(...(await listOpenDealsByStage(stageId)));
  }
  let filtered = deals.filter(allowed);
  if (opts.nameContains) {
    const needle = opts.nameContains.toLowerCase();
    filtered = filtered.filter((d) => d.title.toLowerCase().includes(needle));
  }

  const personIds = [...new Set(filtered.map((d) => d.person_id).filter((x): x is number => !!x))];
  const persons = await getPersonsByIds(personIds);

  const { data: hotFlags } = await db
    .from("hot_flags")
    .select("deal_id, reason")
    .is("cleared_at", null);
  const hotByDeal = new Map((hotFlags ?? []).map((f) => [f.deal_id, f.reason]));

  let skippedNoPhone = 0;
  const leads: QueueLead[] = [];
  for (const d of filtered) {
    const person = d.person_id ? persons.get(d.person_id) : undefined;
    const phone = normalizePhone(person?.phone);
    if (!phone) {
      skippedNoPhone++;
      continue; // hygiene guard: no dialable phone → not in queue
    }
    leads.push({
      dealId: d.id,
      title: d.title,
      personName: person?.name ?? null,
      phone,
      stageId: d.stage_id,
      stageName: STAGE_NAMES[d.stage_id] ?? `Stage ${d.stage_id}`,
      ownerId: d.owner_id,
      updateTime: d.update_time,
      hot: hotByDeal.has(d.id),
      hotReason: hotByDeal.get(d.id) ?? null,
    });
  }

  // Ordering rule: hot-list deals first, then oldest-untouched first.
  leads.sort((a, b) => {
    if (a.hot !== b.hot) return a.hot ? -1 : 1;
    return (a.updateTime ?? "").localeCompare(b.updateTime ?? "");
  });

  return { leads, skippedNoPhone };
}

// Warm-lambda cache: queue builds hit several Pipedrive pages, and the
// queue list + detail + counts all reuse the same result.
const queueCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof buildQueueLeads>> }>();
const CACHE_TTL_MS = 120_000;

export async function cachedQueueLeads(
  opts: Parameters<typeof buildQueueLeads>[0] & { cacheKey: string }
): Promise<Awaited<ReturnType<typeof buildQueueLeads>>> {
  const key = `${opts.cacheKey}:${opts.user.authUserId}:${opts.ownerScope}:${opts.nameContains ?? ""}`;
  const hit = queueCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = await buildQueueLeads(opts);
  queueCache.set(key, { at: Date.now(), data });
  return data;
}

export function invalidateQueueCache() {
  queueCache.clear();
}
