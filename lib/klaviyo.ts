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
      events.push({
        email,
        occurredAt: ev.attributes?.datetime,
        meta: { klaviyo_event_id: ev.id },
      });
    }
    url = page.links?.next ?? null;
    pages++;
  }
  return events;
}
