import "server-only";
import { supabaseAdmin } from "./supabase";
import { listDealsFiltered, getPersonsByIds, type DealListItem } from "./pipedrive";
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

const POOL_COOLDOWN_DAYS = 2;
const POOL_SLICE = 100; // leads served (and leased) per rep per build
const LEASE_MINUTES = 45;

export async function buildQueueLeads(opts: {
  user: SessionUser;
  stageIds: number[]; // empty = use pipelineId (or whole account)
  ownerScope: OwnerScope;
  nameContains?: string;
  pipelineId?: number;
  status?: "open" | "won" | "lost";
  poolMode?: boolean;
  takeLeases?: boolean; // false for count-only builds
}): Promise<{
  leads: QueueLead[];
  skippedNoPhone: number;
  skippedOwnership: number;
  truncated: boolean;
  pool?: { eligible: number; coolingDown: number; leasedByOthers: number };
}> {
  const db = supabaseAdmin();
  const { data: reps } = await db
    .from("reps")
    .select("pipedrive_user_id")
    .eq("active", true)
    .not("pipedrive_user_id", "is", null);
  const repIds = new Set((reps ?? []).map((r) => r.pipedrive_user_id as number));
  const allowed = buildOwnerCheck(opts.user, opts.ownerScope, repIds);

  const status = opts.status ?? "open";
  const DEAL_CAP = 3000; // per stage/pipeline — well above current volumes
  const deals: DealListItem[] = [];
  let truncated = false;
  if (opts.stageIds.length > 0) {
    for (const stageId of opts.stageIds) {
      const batch = await listDealsFiltered({ stageId, status }, DEAL_CAP);
      if (batch.length >= DEAL_CAP) truncated = true;
      deals.push(...batch);
    }
  } else {
    const batch = await listDealsFiltered({ pipelineId: opts.pipelineId, status }, DEAL_CAP);
    if (batch.length >= DEAL_CAP) truncated = true;
    deals.push(...batch);
  }
  let filtered = deals.filter(allowed);
  const skippedOwnership = deals.length - filtered.length;
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

  if (opts.poolMode) {
    const pool = await applyPoolRules(db, leads, opts.user.email, opts.takeLeases !== false);
    return { leads: pool.leads, skippedNoPhone, skippedOwnership, truncated, pool: pool.stats };
  }

  return { leads, skippedNoPhone, skippedOwnership, truncated };
}

/**
 * Shared-pool rules: 2-day cooldown after any attempt, exclusion of deals
 * currently leased to another rep, fewest-attempts-first ordering (nobody
 * gets call #2 until every deal has had call #1). The served slice gets
 * leased so simultaneous dialers never hold the same lead.
 */
async function applyPoolRules(
  db: ReturnType<typeof supabaseAdmin>,
  leads: QueueLead[],
  actor: string,
  takeLeases: boolean
): Promise<{ leads: QueueLead[]; stats: { eligible: number; coolingDown: number; leasedByOthers: number } }> {
  const now = Date.now();
  const dealIds = leads.map((l) => l.dealId);
  if (dealIds.length === 0) return { leads, stats: { eligible: 0, coolingDown: 0, leasedByOthers: 0 } };

  const cooldownCutoff = new Date(now - POOL_COOLDOWN_DAYS * 24 * 3600_000).toISOString();
  const [attemptsRes, leasesRes] = await Promise.all([
    db.from("dial_attempts").select("deal_id, attempted_at").in("deal_id", dealIds),
    db.from("dial_leases").select("deal_id, actor").gt("expires_at", new Date(now).toISOString()),
  ]);

  const attemptCount = new Map<number, number>();
  const lastAttempt = new Map<number, string>();
  for (const a of attemptsRes.data ?? []) {
    attemptCount.set(a.deal_id, (attemptCount.get(a.deal_id) ?? 0) + 1);
    if ((lastAttempt.get(a.deal_id) ?? "") < a.attempted_at) lastAttempt.set(a.deal_id, a.attempted_at);
  }
  const leasedByOther = new Set(
    (leasesRes.data ?? []).filter((l) => l.actor !== actor).map((l) => l.deal_id)
  );

  let coolingDown = 0;
  let leasedCount = 0;
  const eligible = leads.filter((l) => {
    const last = lastAttempt.get(l.dealId);
    if (last && last > cooldownCutoff) {
      coolingDown++;
      return false;
    }
    if (leasedByOther.has(l.dealId)) {
      leasedCount++;
      return false;
    }
    return true;
  });

  eligible.sort((a, b) => {
    const ca = attemptCount.get(a.dealId) ?? 0;
    const cb = attemptCount.get(b.dealId) ?? 0;
    if (ca !== cb) return ca - cb; // fewest attempts first — round fairness
    const la = lastAttempt.get(a.dealId) ?? "";
    const lb = lastAttempt.get(b.dealId) ?? "";
    if (la !== lb) return la.localeCompare(lb); // least recently attempted
    return (a.updateTime ?? "").localeCompare(b.updateTime ?? "");
  });

  const slice = eligible.slice(0, POOL_SLICE);
  if (takeLeases && slice.length > 0) {
    const expires = new Date(now + LEASE_MINUTES * 60_000).toISOString();
    const { error } = await db.from("dial_leases").upsert(
      slice.map((l) => ({ deal_id: l.dealId, actor, expires_at: expires })),
      { onConflict: "deal_id" }
    );
    if (error) console.error("lease upsert failed", error);
  }

  return {
    leads: slice,
    stats: { eligible: eligible.length, coolingDown, leasedByOthers: leasedCount },
  };
}

// Warm-lambda cache: queue builds hit several Pipedrive pages, and the
// queue list + detail + counts all reuse the same result.
const queueCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof buildQueueLeads>> }>();
const CACHE_TTL_MS = 120_000;

export async function cachedQueueLeads(
  opts: Parameters<typeof buildQueueLeads>[0] & { cacheKey: string }
): Promise<Awaited<ReturnType<typeof buildQueueLeads>>> {
  // Real pool builds take leases — they must always be fresh. (Count-only
  // pool builds may cache like everything else.)
  if (opts.poolMode && opts.takeLeases !== false) return buildQueueLeads(opts);
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
