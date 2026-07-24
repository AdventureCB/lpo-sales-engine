import "server-only";
import { env } from "./env";

/**
 * Pipedrive client for the hot-list engine: resolve person→open deals, apply
 * or remove the "🔥 Hot" label, create the due-today call activity. The
 * native Quo↔Pipedrive integration handles call logging — we never write
 * call activities here (no double-logging).
 */

const V1 = "https://api.pipedrive.com/v1";
const V2 = "https://api.pipedrive.com/api/v2";

export class PipedriveRateLimitError extends Error {}

async function pd(base: string, path: string, init?: RequestInit & { params?: Record<string, string> }): Promise<any> {
  const url = new URL(`${base}${path}`);
  url.searchParams.set("api_token", env("PIPEDRIVE_API_TOKEN"));
  for (const [k, v] of Object.entries(init?.params ?? {})) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      body: init?.body,
    });
    if (res.status === 429) {
      // Token-bucket limit: back off once, then surface a typed error so
      // batch jobs can stop cleanly and resume next sweep.
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      throw new PipedriveRateLimitError(`Pipedrive ${path} 429 after retry`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      throw new Error(`Pipedrive ${path} ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
    }
    return json.data;
  }
}

export async function findPersonIdByEmail(email: string): Promise<number | null> {
  const data = await pd(V1, "/persons/search", {
    params: { term: email, fields: "email", exact_match: "true", limit: "1" },
  });
  return data?.items?.[0]?.item?.id ?? null;
}

export interface PipedriveDeal {
  id: number;
  title: string;
  status: string;
  owner_id: number;
  owner_name?: string;
  label_ids: number[];
  person_id: number | null;
}

export async function getOpenDealsForPerson(personId: number): Promise<PipedriveDeal[]> {
  const data = await pd(V1, `/persons/${personId}/deals`, { params: { status: "open", limit: "50" } });
  return (data ?? []).map((d: any) => ({
    id: d.id,
    title: d.title,
    status: d.status,
    owner_id: typeof d.user_id === "object" ? d.user_id?.id : d.user_id,
    owner_name: typeof d.user_id === "object" ? d.user_id?.name : undefined,
    label_ids: d.label_ids ?? [],
  }));
}

export async function getDeal(dealId: number): Promise<PipedriveDeal> {
  const d = await pd(V1, `/deals/${dealId}`);
  return {
    id: d.id,
    title: d.title,
    status: d.status,
    owner_id: typeof d.user_id === "object" ? d.user_id?.id : d.user_id,
    owner_name: typeof d.user_id === "object" ? d.user_id?.name : undefined,
    label_ids: d.label_ids ?? [],
    person_id: typeof d.person_id === "object" ? d.person_id?.value ?? null : d.person_id ?? null,
  };
}

export interface PersonActivity {
  id: number;
  type: string;
  subject: string | null;
  note: string | null;
  deal_id: number | null;
  add_time: string | null; // UTC "YYYY-MM-DD HH:MM:SS"
}

export async function getRecentPersonActivities(personId: number): Promise<PersonActivity[]> {
  const data = await pd(V1, `/persons/${personId}/activities`, {
    params: { limit: "20" },
  });
  return (data ?? []).map((a: any) => ({
    id: a.id,
    type: a.type,
    subject: a.subject ?? null,
    note: a.note ?? null,
    deal_id: a.deal_id ?? null,
    add_time: a.add_time ?? null,
  }));
}

export async function updateActivity(
  id: number,
  fields: { deal_id?: number; note?: string }
): Promise<void> {
  await pd(V1, `/activities/${id}`, { method: "PUT", body: JSON.stringify(fields) });
}

export async function addDealNote(dealId: number, content: string): Promise<void> {
  await pd(V1, "/notes", {
    method: "POST",
    body: JSON.stringify({ deal_id: dealId, content }),
  });
}

let hotLabelIdCache: number | null | undefined;

/** The "🔥 Hot"/"Hot" option on the deal label field; null if none exists. */
export async function getHotLabelId(): Promise<number | null> {
  if (hotLabelIdCache !== undefined) return hotLabelIdCache;
  const fields = await pd(V1, "/dealFields", { params: { limit: "500" } });
  const labelField = (fields ?? []).find((f: any) => f.key === "label_ids" || f.key === "label");
  const option = (labelField?.options ?? []).find((o: any) => /hot/i.test(o.label ?? ""));
  const id: number | null = option?.id ?? null;
  hotLabelIdCache = id;
  return id;
}

export async function setDealLabels(dealId: number, labelIds: number[]): Promise<void> {
  await pd(V2, `/deals/${dealId}`, {
    method: "PATCH",
    body: JSON.stringify({ label_ids: labelIds }),
  });
}

export interface DealListItem {
  id: number;
  title: string;
  stage_id: number;
  owner_id: number;
  person_id: number | null;
  update_time: string | null;
}

export interface DealFilter {
  stageId?: number;
  pipelineId?: number;
  status?: "open" | "won" | "lost"; // undefined = any (not deleted)
}

/** Deals matching a stage/pipeline/status filter (v2 cursor pagination), capped. */
export async function listDealsFiltered(filter: DealFilter, cap = 300): Promise<DealListItem[]> {
  const deals: DealListItem[] = [];
  let cursor: string | null = null;
  while (deals.length < cap) {
    const params: Record<string, string> = { limit: "100" };
    if (filter.stageId) params.stage_id = String(filter.stageId);
    if (filter.pipelineId) params.pipeline_id = String(filter.pipelineId);
    if (filter.status) params.status = filter.status;
    if (cursor) params.cursor = cursor;
    const url = new URL(`${V2}/deals`);
    url.searchParams.set("api_token", env("PIPEDRIVE_API_TOKEN"));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      throw new Error(`Pipedrive v2 deals ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    }
    for (const d of json.data ?? []) {
      deals.push({
        id: d.id,
        title: d.title,
        stage_id: d.stage_id,
        owner_id: d.owner_id,
        person_id: d.person_id ?? null,
        update_time: d.update_time ?? null,
      });
    }
    cursor = json.additional_data?.next_cursor ?? null;
    if (!cursor) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return deals;
}

export interface DealSearchHit {
  id: number;
  title: string;
  status: string;
  stage_id: number | null;
  owner_id: number | null;
  person_id: number | null;
  person_name: string | null;
}

/** Full-text deal search across all of Pipedrive. */
export async function searchDeals(term: string, limit = 15): Promise<DealSearchHit[]> {
  const data = await pd(V2, "/deals/search", {
    params: { term, limit: String(limit) },
  });
  return (data?.items ?? []).map((hit: any) => {
    const item = hit.item ?? {};
    return {
      id: item.id,
      title: item.title,
      status: item.status ?? "open",
      stage_id: item.stage?.id ?? null,
      owner_id: item.owner?.id ?? null,
      person_id: item.person?.id ?? null,
      person_name: item.person?.name ?? null,
    };
  });
}

export interface PersonPhone {
  id: number;
  name: string;
  phone: string | null; // raw primary phone
  email: string | null;
}

/** Persons by id (v2, batches of 100) — name + primary phone/email. */
export async function getPersonsByIds(ids: number[]): Promise<Map<number, PersonPhone>> {
  const out = new Map<number, PersonPhone>();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const data = await pd(V2, "/persons", { params: { ids: batch.join(","), limit: "100" } });
    for (const p of data ?? []) {
      const phones = p.phones ?? [];
      const primary = phones.find((x: any) => x.primary) ?? phones[0];
      const emails = p.emails ?? [];
      const primaryEmail = emails.find((x: any) => x.primary) ?? emails[0];
      out.set(p.id, {
        id: p.id,
        name: p.name,
        phone: primary?.value ?? null,
        email: primaryEmail?.value ?? null,
      });
    }
    if (i + 100 < ids.length) await new Promise((r) => setTimeout(r, 200));
  }
  return out;
}

export interface DealActivity {
  id: number;
  type: string;
  subject: string | null;
  done: boolean;
  due_date: string | null;
  add_time: string | null;
  owner_id: number | null;
}

/** Most recent activities on a deal (done or upcoming), newest first. */
export async function getDealActivities(dealId: number, limit = 3): Promise<DealActivity[]> {
  const data = await pd(V2, "/activities", {
    params: {
      deal_id: String(dealId),
      limit: String(limit),
      sort_by: "add_time",
      sort_direction: "desc",
    },
  });
  return (data ?? []).map((a: any) => ({
    id: a.id,
    type: a.type ?? "task",
    subject: a.subject ?? null,
    done: Boolean(a.done),
    due_date: a.due_date ?? null,
    add_time: a.add_time ?? null,
    owner_id: a.owner_id ?? null,
  }));
}

/** Latest notes on a deal (for the lead card). */
export async function getDealNotes(dealId: number, limit = 2): Promise<string[]> {
  const data = await pd(V1, "/notes", {
    params: { deal_id: String(dealId), limit: String(limit), sort: "add_time DESC" },
  });
  return (data ?? []).map((n: any) =>
    String(n.content ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export interface SentThread {
  id: number;
  subject: string | null;
  deal_id: number | null;
  mail_tracking_status: string | null; // "opened" | "not_opened" | null
  last_message_timestamp: string | null;
  to_email: string | null;
}

/** Sent mail threads with last activity since `sinceIso` (tracking flags included). */
export async function getRecentSentThreads(sinceIso: string): Promise<SentThread[]> {
  const since = Date.parse(sinceIso);
  const threads: SentThread[] = [];
  let start = 0;
  for (let page = 0; page < 10; page++) {
    const data = await pd(V1, "/mailbox/mailThreads", {
      params: { folder: "sent", limit: "50", start: String(start) },
    });
    const batch = data ?? [];
    if (batch.length === 0) break;
    let reachedOld = false;
    for (const t of batch) {
      const ts = t.last_message_timestamp ? Date.parse(t.last_message_timestamp) : 0;
      if (ts < since) {
        reachedOld = true;
        continue;
      }
      threads.push({
        id: t.id,
        subject: t.subject ?? null,
        deal_id: t.deal_id ?? null,
        mail_tracking_status: t.mail_tracking_status ?? null,
        last_message_timestamp: t.last_message_timestamp ?? null,
        to_email: t.parties?.to?.[0]?.email_address ?? null,
      });
    }
    if (reachedOld) break;
    start += batch.length;
    await new Promise((r) => setTimeout(r, 250));
  }
  return threads;
}

export async function createDueTodayActivity(opts: {
  dealId: number;
  ownerId: number;
  subject: string;
  note?: string;
}): Promise<void> {
  await pd(V1, "/activities", {
    method: "POST",
    body: JSON.stringify({
      subject: opts.subject,
      note: opts.note,
      type: "task",
      deal_id: opts.dealId,
      user_id: opts.ownerId,
      due_date: new Date().toISOString().slice(0, 10),
    }),
  });
}
