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
  };
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
