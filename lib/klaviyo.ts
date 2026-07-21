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

export async function getMetricIds(): Promise<Map<string, string>> {
  if (metricIdCache) return metricIdCache;
  const ids = new Map<string, string>();
  let url: string | null = `${BASE}/metrics/`;
  while (url) {
    const page = await kGet(url);
    for (const m of page.data ?? []) ids.set(m.attributes?.name, m.id);
    url = page.links?.next ?? null;
  }
  metricIdCache = ids;
  return ids;
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
  metric: string;
  datetime: string;
  detail: Record<string, unknown>;
}

/** Recent events for a profile, newest first, metric names resolved. */
export async function getProfileEvents(profileId: string, limit = 25): Promise<KlaviyoProfileEvent[]> {
  const filter = encodeURIComponent(`equals(profile_id,"${profileId}")`);
  const page = await kGet(`${BASE}/events/?filter=${filter}&include=metric&sort=-datetime`);
  const metricNames = new Map<string, string>();
  for (const inc of page.included ?? []) {
    if (inc.type === "metric") metricNames.set(inc.id, inc.attributes?.name ?? inc.id);
  }
  const events: KlaviyoProfileEvent[] = [];
  for (const ev of page.data ?? []) {
    if (events.length >= limit) break;
    const props = ev.attributes?.event_properties ?? {};
    const detail: Record<string, unknown> = {};
    for (const key of ["Subject", "Campaign Name", "URL", "$value", "Name", "Items"]) {
      const v = props[key];
      if (v !== undefined && v !== null && v !== "") {
        detail[key] = typeof v === "object" ? JSON.stringify(v).slice(0, 160) : v;
      }
    }
    // fall back to the first few scalar props (builder saves etc. use custom keys)
    if (Object.keys(detail).length === 0) {
      for (const [k, v] of Object.entries(props)) {
        if (Object.keys(detail).length >= 3) break;
        if (k.startsWith("$")) continue;
        if (typeof v === "string" || typeof v === "number") detail[k] = String(v).slice(0, 120);
      }
    }
    events.push({
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
export async function getEventsForMetric(metricId: string, sinceIso: string): Promise<KlaviyoEvent[]> {
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
