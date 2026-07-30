import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "./identity";

/**
 * Pipedrive → CRM mirror mapping. Used by the webhook receiver (incremental)
 * and the importer (backfill). One direction only: Pipedrive stays the
 * system of record until cutover.
 */

const stageIdCache = new Map<number, string>();
const contactIdCache = new Map<number, string>();

export async function crmStageId(db: SupabaseClient, pipedriveStageId: number | null): Promise<string | null> {
  if (!pipedriveStageId) return null;
  const hit = stageIdCache.get(pipedriveStageId);
  if (hit) return hit;
  const { data } = await db
    .from("crm_stages")
    .select("id")
    .eq("pipedrive_stage_id", pipedriveStageId)
    .maybeSingle();
  if (data) stageIdCache.set(pipedriveStageId, data.id);
  return data?.id ?? null;
}

export async function crmContactId(db: SupabaseClient, pipedrivePersonId: number | null): Promise<string | null> {
  if (!pipedrivePersonId) return null;
  const hit = contactIdCache.get(pipedrivePersonId);
  if (hit) return hit;
  const { data } = await db
    .from("crm_contacts")
    .select("id")
    .eq("pipedrive_person_id", pipedrivePersonId)
    .maybeSingle();
  if (data) contactIdCache.set(pipedrivePersonId, data.id);
  return data?.id ?? null;
}

/** v1 webhook payloads and v2 API rows differ slightly — accept both. */
export function personRowFromPipedrive(p: any) {
  const emails = (p.emails ?? p.email ?? []).map((e: any) => ({
    value: typeof e === "string" ? e : e.value,
    primary: typeof e === "object" ? Boolean(e.primary) : false,
  }));
  const phones = (p.phones ?? p.phone ?? [])
    .map((ph: any) => ({
      value: typeof ph === "string" ? ph : ph.value,
      e164: normalizePhone(typeof ph === "string" ? ph : ph.value),
      primary: typeof ph === "object" ? Boolean(ph.primary) : false,
    }))
    .filter((ph: any) => ph.value);
  return {
    pipedrive_person_id: p.id,
    name: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ") ?? "Unknown",
    first_name: p.first_name ?? null,
    last_name: p.last_name ?? null,
    emails,
    phones,
    org_name: typeof p.org_id === "object" ? p.org_id?.name ?? null : null,
    updated_at: new Date().toISOString(),
  };
}

export async function upsertContact(db: SupabaseClient, p: any): Promise<void> {
  const row = personRowFromPipedrive(p);
  const { error } = await db
    .from("crm_contacts")
    .upsert(row, { onConflict: "pipedrive_person_id" });
  if (error) throw new Error(`contact upsert: ${error.message}`);
}

/** Importer path: a whole page of persons in one statement. */
export async function upsertContactsBatch(db: SupabaseClient, persons: any[]): Promise<void> {
  if (persons.length === 0) return;
  // Dedupe within the batch — Postgres rejects an upsert that touches the
  // same conflict key twice in one statement.
  const byId = new Map(persons.map((p) => [p.id, personRowFromPipedrive(p)]));
  const { error } = await db
    .from("crm_contacts")
    .upsert([...byId.values()], { onConflict: "pipedrive_person_id" });
  if (error) throw new Error(`contacts batch upsert: ${error.message}`);
}

/** Importer path: a whole page of deals — resolve FKs in bulk, one upsert. */
export async function upsertDealsBatch(db: SupabaseClient, deals: any[]): Promise<void> {
  if (deals.length === 0) return;
  const personIdOf = (d: any): number | null =>
    typeof d.person_id === "object" ? d.person_id?.value ?? null : d.person_id ?? null;

  // Stage uuids come from the (small, cached) stage map.
  const stageIds = [...new Set(deals.map((d) => d.stage_id).filter(Boolean))] as number[];
  const stageMap = new Map<number, string | null>();
  for (const sid of stageIds) stageMap.set(sid, await crmStageId(db, sid));

  // Contact uuids in chunked .in() queries instead of one query per deal.
  const personIds = [...new Set(deals.map(personIdOf).filter(Boolean))] as number[];
  const contactMap = new Map<number, string>();
  for (let i = 0; i < personIds.length; i += 200) {
    const { data, error } = await db
      .from("crm_contacts")
      .select("id, pipedrive_person_id")
      .in("pipedrive_person_id", personIds.slice(i, i + 200));
    if (error) throw new Error(`contact lookup: ${error.message}`);
    for (const r of data ?? []) contactMap.set(r.pipedrive_person_id, r.id);
  }

  const byId = new Map(
    deals.map((d) => {
      const pid = personIdOf(d);
      return [d.id, dealRowFromPipedrive(d, stageMap.get(d.stage_id) ?? null, pid ? contactMap.get(pid) ?? null : null)];
    })
  );
  const { error } = await db.from("crm_deals").upsert([...byId.values()], { onConflict: "pipedrive_deal_id" });
  if (error) throw new Error(`deals batch upsert: ${error.message}`);
}

function dealRowFromPipedrive(d: any, stageUuid: string | null, contactUuid: string | null) {
  const ownerId = typeof d.user_id === "object" ? d.user_id?.id ?? null : d.user_id ?? d.owner_id ?? null;
  const valueCents =
    d.value !== undefined && d.value !== null ? Math.round(Number(d.value) * 100) : null;
  return {
    pipedrive_deal_id: d.id,
    title: d.title ?? "Untitled",
    contact_id: contactUuid,
    stage_id: stageUuid,
    status: ["open", "won", "lost"].includes(d.status) ? d.status : "open",
    value_cents: Number.isFinite(valueCents) ? valueCents : null,
    owner_pipedrive_id: ownerId,
    label: null,
    source: d.origin ?? null,
    stage_changed_at: d.stage_change_time ?? null,
    won_at: d.won_time || null,
    lost_at: d.lost_time || null,
    lost_reason: d.lost_reason ?? null,
    pd_add_time: d.add_time ?? null,
    last_activity_at: d.last_activity_date ?? null,
    updated_at: new Date().toISOString(),
  };
}

export async function upsertDeal(
  db: SupabaseClient,
  d: any,
  opts: { emitEvents?: boolean } = {}
): Promise<void> {
  const personId =
    typeof d.person_id === "object" ? d.person_id?.value ?? null : d.person_id ?? null;
  const stageUuid = await crmStageId(db, d.stage_id ?? null);
  // Snapshot the pre-upsert state so we can emit created/stage-changed events.
  let existing: { id: string; stage_id: string | null } | null = null;
  if (opts.emitEvents) {
    const { data } = await db
      .from("crm_deals")
      .select("id, stage_id")
      .eq("pipedrive_deal_id", d.id)
      .maybeSingle();
    existing = data ?? null;
  }
  const contactUuid = await crmContactId(db, personId);
  const row = dealRowFromPipedrive(d, stageUuid, contactUuid);
  const { data: upserted, error } = await db
    .from("crm_deals")
    .upsert(row, { onConflict: "pipedrive_deal_id" })
    .select("id")
    .single();
  if (error) throw new Error(`deal upsert: ${error.message}`);

  if (opts.emitEvents && upserted) {
    const { enqueueEvent } = await import("./automations");
    if (!existing) {
      await enqueueEvent(db, "deal_created", {
        crm_deal_id: upserted.id,
        pipedrive_deal_id: d.id,
        stage_id: stageUuid,
      });
    } else if (stageUuid && existing.stage_id !== stageUuid) {
      await enqueueEvent(db, "deal_stage_changed", {
        crm_deal_id: upserted.id,
        pipedrive_deal_id: d.id,
        from_stage_id: existing.stage_id,
        to_stage_id: stageUuid,
      });
    }
  }
}

export async function syncPipelinesAndStages(
  db: SupabaseClient,
  pipelines: any[],
  stages: any[]
): Promise<void> {
  for (const p of pipelines) {
    const { error } = await db
      .from("crm_pipelines")
      .upsert(
        { pipedrive_pipeline_id: p.id, name: p.name, sort_order: p.order_nr ?? 0 },
        { onConflict: "pipedrive_pipeline_id" }
      );
    if (error) throw new Error(error.message);
  }
  const { data: pls } = await db.from("crm_pipelines").select("id, pipedrive_pipeline_id");
  const plMap = new Map((pls ?? []).map((x) => [x.pipedrive_pipeline_id, x.id]));
  for (const s of stages) {
    const pipelineUuid = plMap.get(s.pipeline_id);
    if (!pipelineUuid) continue;
    const { error } = await db.from("crm_stages").upsert(
      {
        pipedrive_stage_id: s.id,
        pipeline_id: pipelineUuid,
        name: s.name,
        sort_order: s.order_nr ?? 0,
      },
      { onConflict: "pipedrive_stage_id" }
    );
    if (error) throw new Error(error.message);
  }
  stageIdCache.clear();
}
