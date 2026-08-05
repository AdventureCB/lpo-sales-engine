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

  const contactMap = await pdIdMap(db, "crm_contacts", "pipedrive_person_id", deals.map(personIdOf));
  const srcMap = await sourceIdsForChannels(db, deals.map((d) => d.channel));

  const byId = new Map(
    deals.map((d) => {
      const pid = personIdOf(d);
      return [d.id, dealRowFromPipedrive(d, stageMap.get(d.stage_id) ?? null, pid ? contactMap.get(pid) ?? null : null, srcMap.get(d.channel) ?? null)];
    })
  );
  const { error } = await db.from("crm_deals").upsert([...byId.values()], { onConflict: "pipedrive_deal_id" });
  if (error) throw new Error(`deals batch upsert: ${error.message}`);
}

/** Bulk pipedrive-id → crm-uuid lookup, chunked to keep URLs sane. */
async function pdIdMap(
  db: SupabaseClient,
  table: string,
  idColumn: string,
  ids: Array<number | null | undefined>
): Promise<Map<number, string>> {
  const unique = [...new Set(ids.filter(Boolean))] as number[];
  const map = new Map<number, string>();
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await db
      .from(table)
      .select(`id, ${idColumn}`)
      .in(idColumn, unique.slice(i, i + 200));
    if (error) throw new Error(`${table} lookup: ${error.message}`);
    for (const r of (data ?? []) as any[]) map.set(r[idColumn], r.id);
  }
  return map;
}

function stripHtml(s: string | null | undefined): string | null {
  if (!s) return null;
  const text = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
  return text || null;
}

/** Importer: a page of Pipedrive notes → crm_activities (type "note"). */
export async function upsertNotesBatch(db: SupabaseClient, notes: any[]): Promise<void> {
  if (notes.length === 0) return;
  const dealMap = await pdIdMap(db, "crm_deals", "pipedrive_deal_id", notes.map((n) => n.deal_id));
  const contactMap = await pdIdMap(db, "crm_contacts", "pipedrive_person_id", notes.map((n) => n.person_id));
  const rows = new Map(
    notes
      .map((n) => ({
        pipedrive_note_id: n.id,
        deal_id: n.deal_id ? dealMap.get(n.deal_id) ?? null : null,
        contact_id: n.person_id ? contactMap.get(n.person_id) ?? null : null,
        type: "note",
        body: stripHtml(n.content),
        actor: n.user?.email ?? null,
        occurred_at: n.add_time ?? new Date().toISOString(),
      }))
      .filter((r) => (r.deal_id || r.contact_id) && r.body)
      .map((r) => [r.pipedrive_note_id, r])
  );
  if (rows.size === 0) return;
  const { error } = await db
    .from("crm_activities")
    .upsert([...rows.values()], { onConflict: "pipedrive_note_id" });
  if (error) throw new Error(`notes batch upsert: ${error.message}`);
}

const ACTIVITY_TYPE_MAP: Record<string, string> = {
  call: "call",
  meeting: "meeting",
  email: "email",
  task: "task",
  deadline: "task",
  lunch: "meeting",
};

/** Importer: a page of Pipedrive activities → crm_activities. */
export async function upsertActivitiesBatch(db: SupabaseClient, activities: any[]): Promise<void> {
  if (activities.length === 0) return;
  const dealMap = await pdIdMap(db, "crm_deals", "pipedrive_deal_id", activities.map((a) => a.deal_id));
  const contactMap = await pdIdMap(db, "crm_contacts", "pipedrive_person_id", activities.map((a) => a.person_id));
  const rows = new Map(
    activities
      .map((a) => ({
        pipedrive_activity_id: a.id,
        deal_id: a.deal_id ? dealMap.get(a.deal_id) ?? null : null,
        contact_id: a.person_id ? contactMap.get(a.person_id) ?? null : null,
        type: ACTIVITY_TYPE_MAP[a.type] ?? "task",
        subject: a.subject ?? null,
        body: stripHtml(a.note),
        due_at: a.due_date ? `${a.due_date}T${a.due_time || "00:00"}:00Z` : null,
        done_at: a.marked_as_done_time || null,
        occurred_at: a.add_time ?? new Date().toISOString(),
        meta: { pipedrive_owner_id: a.owner_id ?? a.user_id ?? null },
      }))
      .filter((r) => r.deal_id || r.contact_id)
      .map((r) => [r.pipedrive_activity_id, r])
  );
  if (rows.size === 0) return;
  const { error } = await db
    .from("crm_activities")
    .upsert([...rows.values()], { onConflict: "pipedrive_activity_id" });
  if (error) throw new Error(`activities batch upsert: ${error.message}`);
}

/**
 * Importer: one deal's flow feed → synced emails + deal-change log entries.
 * Activities and notes in the feed are skipped (imported by their own phases).
 */
export async function upsertDealFlowBatch(
  db: SupabaseClient,
  deal: { id: string; contact_id: string | null },
  items: any[],
  stageNames: Map<number, string>
): Promise<{ emails: number; changes: number }> {
  const rows = new Map<string, Record<string, unknown>>();
  const stageName = (v: any) => stageNames.get(Number(v)) ?? String(v ?? "?");
  for (const it of items) {
    const o = it?.data ?? {};
    if (it?.object === "mailMessage") {
      const from = (o.from ?? [])[0];
      rows.set(`mail:${o.id}`, {
        pd_key: `mail:${o.id}`,
        deal_id: deal.id,
        contact_id: deal.contact_id,
        type: "email",
        subject: o.subject || "(no subject)",
        body: stripHtml(o.snippet) ?? null,
        actor: from?.email_address ?? null,
        occurred_at: o.message_time ?? o.add_time ?? new Date().toISOString(),
      });
    } else if (it?.object === "dealChange") {
      let subject: string | null = null;
      switch (o.field_key) {
        case "stage_id":
          subject = `Stage: ${stageName(o.old_value)} → ${stageName(o.new_value)}`;
          break;
        case "status":
          subject = `Marked ${o.new_value}`;
          break;
        case "user_id":
          subject = "Owner reassigned";
          break;
        case "value":
          subject = `Value: ${o.old_value ?? 0} → ${o.new_value ?? 0}`;
          break;
      }
      if (!subject) continue;
      rows.set(`change:${o.id}`, {
        pd_key: `change:${o.id}`,
        deal_id: deal.id,
        contact_id: deal.contact_id,
        type: "system",
        subject,
        occurred_at: o.log_time ?? new Date().toISOString(),
      });
    }
  }
  if (rows.size > 0) {
    const { error } = await db
      .from("crm_activities")
      .upsert([...rows.values()], { onConflict: "pd_key" });
    if (error) throw new Error(`flow batch upsert: ${error.message}`);
  }
  let emails = 0;
  for (const k of rows.keys()) if (k.startsWith("mail:")) emails++;
  return { emails, changes: rows.size - emails };
}

// Pipedrive channel id → deal_sources uuid, cached per process. Unknown
// channels get a placeholder row (renameable in Settings).
const sourceCache = new Map<number, string>();
export async function sourceIdsForChannels(
  db: SupabaseClient,
  channels: (number | null | undefined)[]
): Promise<Map<number, string>> {
  const need = [...new Set(channels.filter((c): c is number => typeof c === "number"))];
  const missing = need.filter((c) => !sourceCache.has(c));
  if (missing.length > 0) {
    const { data } = await db
      .from("deal_sources")
      .select("id, pipedrive_channel_id")
      .in("pipedrive_channel_id", missing);
    for (const r of data ?? []) sourceCache.set(r.pipedrive_channel_id, r.id);
    for (const c of missing.filter((c) => !sourceCache.has(c))) {
      const { data: ins } = await db
        .from("deal_sources")
        .upsert(
          { pipedrive_channel_id: c, name: `Pipedrive channel ${c}` },
          { onConflict: "pipedrive_channel_id" }
        )
        .select("id")
        .maybeSingle();
      if (ins) sourceCache.set(c, ins.id);
    }
  }
  return new Map(need.filter((c) => sourceCache.has(c)).map((c) => [c, sourceCache.get(c)!]));
}

function dealRowFromPipedrive(
  d: any,
  stageUuid: string | null,
  contactUuid: string | null,
  sourceUuid?: string | null
) {
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
    // Only carry source when Pipedrive actually has a channel — a null here
    // would clobber manual assignments on every webhook re-upsert.
    ...(sourceUuid ? { source_id: sourceUuid } : {}),
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
  const srcMap = await sourceIdsForChannels(db, [d.channel]);
  const row = dealRowFromPipedrive(d, stageUuid, contactUuid, srcMap.get(d.channel) ?? null);
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
