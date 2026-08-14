import "server-only";
import { supabaseAdmin } from "./supabase";
import { normalizePhone } from "./identity";
import type { SessionUser } from "./auth";

export type OwnerScope = "mine" | "unassigned" | "both" | "anyone";

/** Minimal shape the ownership rule needs (owner's Pipedrive user id). */
type OwnedDeal = { owner_id: number | null };

/**
 * Ownership rule: sales reps may work deals they own or deals not assigned
 * to any sales rep ("unassigned" = house/admin-owned). Admin sees anyone's.
 */
export function buildOwnerCheck(
  user: SessionUser,
  scope: OwnerScope,
  repPipedriveIds: Set<number>
): (deal: OwnedDeal) => boolean {
  const mine = (d: OwnedDeal) => d.owner_id === user.pipedriveUserId;
  const unassigned = (d: OwnedDeal) => d.owner_id == null || !repPipedriveIds.has(d.owner_id);
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
  dealId: number; // Pipedrive deal id (0 for native, PD-less deals)
  crmDealId: string; // CRM mirror uuid — the primary key now
  title: string;
  personName: string | null;
  phone: string | null;
  stageId: number | null;
  stageName: string;
  ownerId: number | null;
  updateTime: string | null;
  hot: boolean;
  hotReason: string | null;
}

/** Paginated crm_deals fetch respecting the 1000-row PostgREST cap. */
async function fetchAllDeals(
  build: (from: number, to: number) => any,
  cap: number
): Promise<any[]> {
  const out: any[] = [];
  const PAGE = 1000;
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await build(from, Math.min(from + PAGE, cap) - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
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
  const DEAL_CAP = 5000; // safety bound — well above current volumes

  // The dialer speaks Pipedrive numeric stage/pipeline ids; the mirror keys on
  // uuids. Resolve numeric → uuid up front so we can filter crm_deals.stage_id
  // directly (avoids fragile nested-embed filtering).
  let stageUuids: string[] | null = null;
  if (opts.stageIds.length > 0) {
    const { data } = await db.from("crm_stages").select("id").in("pipedrive_stage_id", opts.stageIds);
    stageUuids = (data ?? []).map((s: any) => s.id);
    if (stageUuids.length === 0) return { leads: [], skippedNoPhone: 0, skippedOwnership: 0, truncated: false };
  } else if (opts.pipelineId != null) {
    const { data: pipe } = await db.from("crm_pipelines").select("id").eq("pipedrive_pipeline_id", opts.pipelineId).maybeSingle();
    if (!pipe) return { leads: [], skippedNoPhone: 0, skippedOwnership: 0, truncated: false };
    const { data } = await db.from("crm_stages").select("id").eq("pipeline_id", pipe.id);
    stageUuids = (data ?? []).map((s: any) => s.id);
    if (stageUuids.length === 0) return { leads: [], skippedNoPhone: 0, skippedOwnership: 0, truncated: false };
  }

  // Read the CRM mirror (Pipedrive is a backup now).
  const cols =
    "id, pipedrive_deal_id, title, status, owner_pipedrive_id, stage_id, last_activity_at, updated_at, contact_id, crm_stages ( id, name ), crm_contacts ( name, phones )";
  const rows = await fetchAllDeals((from, to) => {
    let q = db.from("crm_deals").select(cols).eq("status", status);
    if (stageUuids) q = q.in("stage_id", stageUuids);
    if (opts.nameContains?.trim()) q = q.ilike("title", `%${opts.nameContains.trim().replace(/[%_]/g, "")}%`);
    return q.range(from, to);
  }, DEAL_CAP);
  const truncated = rows.length >= DEAL_CAP;

  const owned = rows
    .map((d: any) => ({ ...d, owner_id: d.owner_pipedrive_id }))
    .filter((d: any) => allowed(d));
  const skippedOwnership = rows.length - owned.length;

  const { data: hotFlags } = await db
    .from("hot_flags")
    .select("deal_id, reason")
    .is("cleared_at", null);
  const hotByDeal = new Map((hotFlags ?? []).map((f) => [f.deal_id, f.reason]));

  // One dialable phone per deal — bad numbers (bad_number disposition) are
  // excluded so a struck deal falls off unless it has a good secondary.
  const pickPhone = (phones: any[]): { e164: string | null; name: string | null } => {
    const ok = (phones ?? []).filter((p) => !p.bad);
    const raw = ok.find((p) => p.primary && p.e164)?.e164 ?? ok.find((p) => p.e164)?.e164 ?? ok.find((p) => p.value)?.value ?? null;
    return { e164: normalizePhone(raw), name: null };
  };

  let skippedNoPhone = 0;
  const leads: QueueLead[] = [];
  for (const d of owned) {
    const phone = pickPhone(d.crm_contacts?.phones ?? []).e164;
    if (!phone) {
      skippedNoPhone++;
      continue; // hygiene guard: no dialable phone → not in queue
    }
    const pdId = d.pipedrive_deal_id ?? 0;
    leads.push({
      dealId: pdId,
      crmDealId: d.id,
      title: d.title,
      personName: d.crm_contacts?.name ?? null,
      phone,
      stageId: d.stage_id ?? null,
      stageName: d.crm_stages?.name ?? "—",
      ownerId: d.owner_pipedrive_id ?? null,
      updateTime: d.last_activity_at ?? d.updated_at ?? null,
      hot: pdId ? hotByDeal.has(pdId) : false,
      hotReason: pdId ? hotByDeal.get(pdId) ?? null : null,
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

// Warm-lambda cache: the queue list + detail + counts all reuse the same
// mirror read within a short window.
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
