import "server-only";
import { env } from "./env";
import { normalizeEmail } from "./identity";

/**
 * Klaviyo Events API — the hot list's marketing-signal source. Metric IDs
 * for "Opened Email" / "Clicked Email" are discovered once per process.
 */

const BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";

async function kGet(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Klaviyo-API-Key ${env("KLAVIYO_PRIVATE_KEY")}`,
      revision: REVISION,
      accept: "application/vnd.api+json",
    },
  });
  if (!res.ok) throw new Error(`Klaviyo ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

let metricIdCache: Map<string, string> | null = null;
let metricsCache: { id: string; name: string; integration: string | null }[] | null = null;

export async function getMetrics(): Promise<{ id: string; name: string; integration: string | null }[]> {
  if (metricsCache) return metricsCache;
  const out: { id: string; name: string; integration: string | null }[] = [];
  let url: string | null = `${BASE}/metrics/`;
  while (url) {
    const page = await kGet(url);
    for (const m of page.data ?? []) {
      out.push({
        id: m.id,
        name: m.attributes?.name,
        integration: m.attributes?.integration?.name ?? null,
      });
    }
    url = page.links?.next ?? null;
  }
  metricsCache = out;
  return out;
}

let listsCache: { id: string; name: string }[] | null = null;

/** All Klaviyo lists — the sub-event picker for list-membership metrics. */
export async function getLists(): Promise<{ id: string; name: string }[]> {
  if (listsCache) return listsCache;
  const out: { id: string; name: string }[] = [];
  let url: string | null = `${BASE}/lists/`;
  while (url) {
    const page = await kGet(url);
    for (const l of page.data ?? []) out.push({ id: l.id, name: l.attributes?.name ?? l.id });
    url = page.links?.next ?? null;
  }
  listsCache = out.sort((a, b) => a.name.localeCompare(b.name));
  return listsCache;
}

export interface ListMember {
  profileId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  properties: Record<string, unknown>;
  joinedAt: string | null;
}

/** Newest group members (join-time desc) — lists and segments share the shape. */
async function recentGroupMembers(kind: "lists" | "segments", groupId: string, pageSize: number): Promise<ListMember[]> {
  const page = await kGet(
    `${BASE}/${kind}/${groupId}/profiles/?sort=-joined_group_at&page[size]=${pageSize}` +
      `&fields[profile]=email,first_name,last_name,phone_number,properties,joined_group_at`
  );
  return (page.data ?? []).map((p: any) => ({
    profileId: p.id,
    email: p.attributes?.email ?? null,
    firstName: p.attributes?.first_name ?? null,
    lastName: p.attributes?.last_name ?? null,
    phone: p.attributes?.phone_number ?? null,
    properties: p.attributes?.properties ?? {},
    joinedAt: p.attributes?.joined_group_at ?? null,
  }));
}

export async function getRecentListMembers(listId: string, pageSize = 50): Promise<ListMember[]> {
  return recentGroupMembers("lists", listId, pageSize);
}

export async function getRecentSegmentMembers(segmentId: string, pageSize = 50): Promise<ListMember[]> {
  return recentGroupMembers("segments", segmentId, pageSize);
}

let segmentsCache: { id: string; name: string }[] | null = null;

/** All Klaviyo segments (cached per instance). */
export async function getSegments(): Promise<{ id: string; name: string }[]> {
  if (segmentsCache) return segmentsCache;
  const out: { id: string; name: string }[] = [];
  let url: string | null = `${BASE}/segments/`;
  while (url) {
    const page = await kGet(url);
    for (const s of page.data ?? []) out.push({ id: s.id, name: s.attributes?.name ?? s.id });
    url = page.links?.next ?? null;
  }
  segmentsCache = out.sort((a, b) => a.name.localeCompare(b.name));
  return segmentsCache;
}

export async function getMetricIds(): Promise<Map<string, string>> {
  if (metricIdCache) return metricIdCache;
  const metrics = await getMetrics();
  metricIdCache = new Map(metrics.map((m) => [m.name, m.id]));
  return metricIdCache;
}

/** Latest event's full properties for a metric — powers the field picker. */
export async function getLatestEventProps(metricId: string): Promise<Record<string, unknown> | null> {
  const filter = encodeURIComponent(`equals(metric_id,"${metricId}")`);
  const page = await kGet(`${BASE}/events/?filter=${filter}&sort=-datetime`);
  const props = page.data?.[0]?.attributes?.event_properties;
  return props && typeof props === "object" ? props : null;
}

/** Stable slug for a metric name; legacy names keep their original slugs. */
const LEGACY_SLUGS: Record<string, string> = {
  "Opened Email": "email_open",
  "Clicked Email": "email_click",
  "3D Builder - Save Build": "builder_save",
  "Checkout Started": "checkout_started",
};
export function metricSlug(name: string): string {
  return LEGACY_SLUGS[name] ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Phone from a Klaviyo profile, looked up by email. */
export async function getProfilePhoneByEmail(email: string): Promise<string | null> {
  const filter = encodeURIComponent(`equals(email,"${email}")`);
  const page = await kGet(`${BASE}/profiles/?filter=${filter}`);
  return page.data?.[0]?.attributes?.phone_number ?? null;
}

export interface KlaviyoProfile {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string | null; // the standard field
  location: Record<string, unknown>;
  properties: Record<string, unknown>; // custom properties (phones hide here too)
  created: string | null;
}

export async function getProfileByEmail(email: string): Promise<KlaviyoProfile | null> {
  const filter = encodeURIComponent(`equals(email,"${email}")`);
  const page = await kGet(`${BASE}/profiles/?filter=${filter}`);
  const p = page.data?.[0];
  if (!p) return null;
  const a = p.attributes ?? {};
  return {
    id: p.id,
    email: a.email ?? null,
    firstName: a.first_name ?? null,
    lastName: a.last_name ?? null,
    phoneNumber: a.phone_number ?? null,
    location: a.location ?? {},
    properties: a.properties ?? {},
    created: a.created ?? null,
  };
}

export interface KlaviyoProfileEvent {
  id: string;
  metric: string;
  datetime: string;
  detail: Record<string, unknown>;
}

/** Recent events for a profile, newest first, metric names resolved.
 * Paginates (events has no page[size]) until `limit` or history runs out.
 * With `sinceIso`, only events strictly newer are fetched (incremental sync). */
export async function getProfileEvents(
  profileId: string,
  limit = 25,
  sinceIso?: string
): Promise<KlaviyoProfileEvent[]> {
  const filter = encodeURIComponent(
    sinceIso
      ? `and(equals(profile_id,"${profileId}"),greater-than(datetime,${sinceIso}))`
      : `equals(profile_id,"${profileId}")`
  );
  const metricNames = new Map<string, string>();
  const rows: any[] = [];
  let url: string | null = `${BASE}/events/?filter=${filter}&include=metric&sort=-datetime`;
  while (url && rows.length < limit) {
    const page: any = await kGet(url);
    for (const inc of page.included ?? []) {
      if (inc.type === "metric") metricNames.set(inc.id, inc.attributes?.name ?? inc.id);
    }
    rows.push(...(page.data ?? []));
    url = page.links?.next ?? null;
  }
  const events: KlaviyoProfileEvent[] = [];
  for (const ev of rows) {
    if (events.length >= limit) break;
    const props = ev.attributes?.event_properties ?? {};
    const detail: Record<string, unknown> = {};
    for (const key of ["Subject", "Campaign Name", "URL", "$value", "Name", "Items"]) {
      const v = props[key];
      if (v !== undefined && v !== null && v !== "") {
        detail[key] = typeof v === "object" ? JSON.stringify(v).slice(0, 400) : v;
      }
    }
    // plus scalar props (builder saves etc. use custom keys) — the deal page
    // shows these on expand, so keep them reasonably complete
    for (const [k, v] of Object.entries(props)) {
      if (Object.keys(detail).length >= 8) break;
      if (k.startsWith("$") || detail[k] !== undefined) continue;
      if (typeof v === "string" || typeof v === "number") detail[k] = String(v).slice(0, 300);
    }
    events.push({
      id: ev.id,
      metric: metricNames.get(ev.relationships?.metric?.data?.id) ?? "event",
      datetime: ev.attributes?.datetime,
      detail,
    });
  }
  return events;
}

export interface KlaviyoEvent {
  email: string;
  occurredAt: string;
  meta: Record<string, unknown>;
}

/** Events for one metric since a timestamp, profile emails resolved. */
export async function getEventsForMetric(
  metricId: string,
  sinceIso: string,
  opts: { fullProps?: boolean } = {}
): Promise<KlaviyoEvent[]> {
  const events: KlaviyoEvent[] = [];
  const filter = encodeURIComponent(
    `and(equals(metric_id,"${metricId}"),greater-or-equal(datetime,${sinceIso}))`
  );
  let url: string | null = `${BASE}/events/?filter=${filter}&include=profile&sort=datetime`;
  let pages = 0;
  while (url && pages < 40) {
    const page = await kGet(url);
    const profileEmails = new Map<string, string>();
    for (const inc of page.included ?? []) {
      const email = normalizeEmail(inc.attributes?.email);
      if (inc.type === "profile" && email) profileEmails.set(inc.id, email);
    }
    for (const ev of page.data ?? []) {
      const profileId = ev.relationships?.profile?.data?.id;
      const email = profileId ? profileEmails.get(profileId) : null;
      if (!email) continue;
      // Keep the human-useful detail (what they engaged with) small: subject,
      // campaign, click URL, order value — not the whole property bag.
      const props = ev.attributes?.event_properties ?? {};
      const detail: Record<string, unknown> = {};
      if (opts.fullProps) {
        // Automation-trigger metrics keep every scalar property (capped) so
        // templates can port any field over.
        let budget = 2000;
        for (const [k, v] of Object.entries(props)) {
          if (budget <= 0) break;
          const val = typeof v === "object" ? JSON.stringify(v).slice(0, 300) : v;
          if (val === undefined || val === null || val === "") continue;
          detail[k] = val;
          budget -= String(val).length + k.length;
        }
      }
      for (const key of ["Subject", "Campaign Name", "URL", "$value", "Name", "Items"]) {
        const v = props[key];
        if (v !== undefined && v !== null && v !== "") {
          detail[key] = typeof v === "object" ? JSON.stringify(v).slice(0, 200) : v;
        }
      }
      events.push({
        email,
        occurredAt: ev.attributes?.datetime,
        meta: { klaviyo_event_id: ev.id, ...detail },
      });
    }
    url = page.links?.next ?? null;
    pages++;
  }
  return events;
}
