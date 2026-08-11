import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueuePdSync } from "./pd-sync";

/**
 * Auto-reassignment: deals a rep has gone quiet on flow back to the shared
 * reprospecting pool (owner → Cainen) so they get worked again.
 *
 * A deal is swept when ALL of:
 *  - open, owned by a rep other than the pool owner, older than the window
 *  - never placed a deposit (deposit/confirmation stages, Order-pipeline
 *    stages, and journey deposit_started_at all disqualify)
 *  - zero REP-INITIATED activity inside the window: outbound dials
 *    (call_events) and crm_activities excluding intake/system actors and
 *    inbound emails — customer engagement alone does not keep a deal
 *  - no pending future-scheduled activity (optional exemption — a follow-up
 *    on the calendar is a plan, not neglect)
 */

export type ReassignConfig = {
  enabled: boolean;
  inactive_days: number;
  target_owner_pipedrive_id: number;
  max_per_run: number;
  exempt_future_scheduled: boolean;
};

export const DEFAULT_REASSIGN_CONFIG: ReassignConfig = {
  enabled: true,
  inactive_days: 91,
  target_owner_pipedrive_id: 24723797, // Cainen — the reprospecting pool
  max_per_run: 500,
  exempt_future_scheduled: true,
};

const CONFIG_KEY = "reassign_config";

export async function loadReassignConfig(db: SupabaseClient): Promise<ReassignConfig> {
  const { data } = await db.from("crm_sync_state").select("value").eq("key", CONFIG_KEY).maybeSingle();
  return { ...DEFAULT_REASSIGN_CONFIG, ...((data?.value as Partial<ReassignConfig>) ?? {}) };
}

export async function saveReassignConfig(db: SupabaseClient, patch: Partial<ReassignConfig>): Promise<ReassignConfig> {
  const merged = { ...(await loadReassignConfig(db)), ...patch };
  await db
    .from("crm_sync_state")
    .upsert({ key: CONFIG_KEY, value: merged, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return merged;
}

export type SweepCandidate = {
  dealId: string;
  pipedriveDealId: number | null;
  title: string;
  ownerPipedriveId: number;
  lastRepActivityAt: string | null; // null = none found inside the window
};

export type SweepResult = {
  matched: number;
  reassigned: number;
  capped: boolean;
  candidates: SweepCandidate[];
};

async function fetchAll(build: (from: number, to: number) => any): Promise<any[]> {
  const out: any[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

export async function sweepInactiveDeals(
  db: SupabaseClient,
  cfg: ReassignConfig,
  opts: { dryRun: boolean }
): Promise<SweepResult> {
  const target = cfg.target_owner_pipedrive_id;
  const cutoff = new Date(Date.now() - cfg.inactive_days * 86_400_000).toISOString();
  const nowIso = new Date().toISOString();

  // Stages that mean "deposit happened": deposit/confirmation stages anywhere
  // plus the entire Order pipeline (post-deposit lifecycle).
  const { data: stages } = await db.from("crm_stages").select("id, name, crm_pipelines ( name )");
  const excludedStages = new Set(
    (stages ?? [])
      .filter((s: any) => /deposit|confirm/i.test(s.name) || /order/i.test(s.crm_pipelines?.name ?? ""))
      .map((s: any) => s.id)
  );

  // Deals that ever started a deposit journey (covers stage moves since).
  const { data: journeys } = await db
    .from("sales_journeys")
    .select("pipedrive_deal_id")
    .not("deposit_started_at", "is", null);
  const depositPdIds = new Set((journeys ?? []).map((j) => j.pipedrive_deal_id));

  // Candidate pool: open, rep-owned, older than the window.
  const deals = (await fetchAll((f, t) =>
    db
      .from("crm_deals")
      .select("id, pipedrive_deal_id, title, owner_pipedrive_id, contact_id, stage_id, created_at, pd_add_time, crm_contacts ( phones )")
      .eq("status", "open")
      .not("owner_pipedrive_id", "is", null)
      .neq("owner_pipedrive_id", target)
      .range(f, t)
  )) as any[];
  const pool = deals.filter((d) => {
    if (excludedStages.has(d.stage_id)) return false;
    if (d.pipedrive_deal_id != null && depositPdIds.has(d.pipedrive_deal_id)) return false;
    const born = d.pd_add_time ?? d.created_at;
    return born != null && born <= cutoff;
  });
  if (pool.length === 0) return { matched: 0, reassigned: 0, capped: false, candidates: [] };

  // Index candidates for activity matching.
  const pdIdToDeal = new Map<number, string>();
  const contactToDeals = new Map<string, string[]>();
  const phoneToDeals = new Map<string, string[]>();
  for (const d of pool) {
    if (d.pipedrive_deal_id != null) pdIdToDeal.set(d.pipedrive_deal_id, d.id);
    if (d.contact_id)
      (contactToDeals.get(d.contact_id) ?? contactToDeals.set(d.contact_id, []).get(d.contact_id)!).push(d.id);
    for (const p of d.crm_contacts?.phones ?? []) {
      if (p.e164) (phoneToDeals.get(p.e164) ?? phoneToDeals.set(p.e164, []).get(p.e164)!).push(d.id);
    }
  }

  // Rep-initiated recency inside the window. Intake/system rows and inbound
  // messages are the customer's motion, not the rep's — they don't count.
  const lastRep = new Map<string, string>();
  const bump = (dealId: string, at: string | null) => {
    if (!at) return;
    const cur = lastRep.get(dealId);
    if (!cur || at > cur) lastRep.set(dealId, at);
  };

  const acts = await fetchAll((f, t) =>
    db
      .from("crm_activities")
      .select("deal_id, contact_id, actor, type, occurred_at, created_at, done_at, direction:meta->>direction")
      .or(`occurred_at.gte.${cutoff},created_at.gte.${cutoff},done_at.gte.${cutoff}`)
      .range(f, t)
  );
  for (const a of acts) {
    if (a.actor === "intake" || a.actor === "system" || a.type === "system") continue;
    if (a.direction === "inbound") continue;
    const at = [a.occurred_at, a.created_at, a.done_at].filter((x) => x && x >= cutoff).sort().pop() ?? null;
    if (!at) continue;
    const ids = a.deal_id ? [a.deal_id] : a.contact_id ? contactToDeals.get(a.contact_id) ?? [] : [];
    for (const id of ids) bump(id, at);
  }

  // Any outbound dial is rep effort, answered or not.
  const calls = await fetchAll((f, t) =>
    db
      .from("call_events")
      .select("deal_id, started_at, raw")
      .eq("direction", "outgoing")
      .gte("started_at", cutoff)
      .range(f, t)
  );
  for (const ce of calls) {
    let ids: string[] = [];
    if (ce.deal_id != null && pdIdToDeal.has(ce.deal_id)) ids = [pdIdToDeal.get(ce.deal_id)!];
    else {
      const parts: string[] = ce.raw?.data?.object?.participants ?? [];
      const seen = new Set<string>();
      for (const p of parts) for (const id of phoneToDeals.get(p) ?? []) seen.add(id);
      ids = [...seen];
    }
    for (const id of ids) bump(id, ce.started_at);
  }

  // Optional exemption: a pending future activity means the rep has a plan.
  const exempt = new Set<string>();
  if (cfg.exempt_future_scheduled) {
    const future = await fetchAll((f, t) =>
      db
        .from("crm_activities")
        .select("deal_id")
        .is("done_at", null)
        .gt("due_at", nowIso)
        .not("deal_id", "is", null)
        .range(f, t)
    );
    for (const a of future) exempt.add(a.deal_id);
  }

  const candidates: SweepCandidate[] = pool
    .filter((d) => !lastRep.has(d.id) && !exempt.has(d.id))
    .map((d) => ({
      dealId: d.id,
      pipedriveDealId: d.pipedrive_deal_id,
      title: d.title,
      ownerPipedriveId: d.owner_pipedrive_id,
      lastRepActivityAt: null,
      _born: d.pd_add_time ?? d.created_at,
      _contactId: d.contact_id,
    }))
    .sort((a: any, b: any) => (a._born ?? "").localeCompare(b._born ?? "")) as any[];

  const matched = candidates.length;
  const batch = candidates.slice(0, Math.max(cfg.max_per_run, 0));
  if (opts.dryRun) return { matched, reassigned: 0, capped: matched > batch.length, candidates: batch };

  const { data: reps } = await db.from("reps").select("name, pipedrive_user_id");
  const repName = (id: number | null) =>
    (reps ?? []).find((r) => r.pipedrive_user_id === id)?.name?.split(" ")[0] ?? (id != null ? `#${id}` : "unassigned");

  let reassigned = 0;
  for (const c of batch as any[]) {
    const { error } = await db
      .from("crm_deals")
      .update({ owner_pipedrive_id: target, updated_at: new Date().toISOString() })
      .eq("id", c.dealId)
      .eq("owner_pipedrive_id", c.ownerPipedriveId); // no-op if someone just took it
    if (error) continue;
    const body = `No rep-initiated activity in ${cfg.inactive_days}+ days — moved from ${repName(c.ownerPipedriveId)} to the reprospecting pool (${repName(target)}).`;
    await db.from("crm_activities").insert({
      deal_id: c.dealId,
      contact_id: c._contactId,
      type: "system",
      actor: "system",
      subject: "♻️ Auto-reassigned to reprospecting pool",
      body,
    });
    if (c.pipedriveDealId != null) {
      await enqueuePdSync(db, "deal_update", { dealId: c.pipedriveDealId, fields: { owner_id: target } });
      await enqueuePdSync(db, "note", { dealId: c.pipedriveDealId, content: `♻️ ${body}` });
    }
    reassigned++;
  }

  return { matched, reassigned, capped: matched > batch.length, candidates: batch };
}
