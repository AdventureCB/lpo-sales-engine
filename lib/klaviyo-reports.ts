import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";
import { getMetricIds } from "./klaviyo";

/**
 * Klaviyo Reporting API → email_stats_monthly. One series report per
 * (kind, 12-month window) returns every campaign/flow × month in that window.
 * Reporting endpoints are rate-limited hard (burst 1/s, steady ~2/min), so
 * callers space requests and treat 429 as "come back later".
 */

const BASE = "https://a.klaviyo.com/api";
// campaign-series-reports only exists from the 2025-01-15 revision on.
const REVISION = "2025-07-15";
const STATS = ["recipients", "delivered", "opens_unique", "clicks_unique", "bounced", "unsubscribes", "spam_complaints", "conversions", "conversion_value"] as const;

export class KlaviyoRateLimited extends Error {
  constructor(public retryAfterS: number) {
    super(`Klaviyo 429 (retry after ${retryAfterS}s)`);
  }
}

async function kFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Klaviyo-API-Key ${env("KLAVIYO_PRIVATE_KEY")}`,
      revision: REVISION,
      accept: "application/vnd.api+json",
      "content-type": "application/vnd.api+json",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 429) throw new KlaviyoRateLimited(Number(res.headers.get("retry-after") ?? 60) || 60);
  if (!res.ok) throw new Error(`Klaviyo ${res.status} ${path}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

export interface MonthStat {
  month: string; // YYYY-MM-01
  kind: "campaign" | "flow";
  entity_id: string;
  recipients: number;
  delivered: number;
  opens_unique: number;
  clicks_unique: number;
  bounced: number;
  unsubscribes: number;
  spam_complaints: number;
  conversions: number;
  conversion_value_cents: number;
}

const monthKey = (iso: string) => `${iso.slice(0, 7)}-01`;

/** Series report, monthly interval, for [startIso, endIso) (≤ 1 year). */
export async function seriesReport(kind: "campaign" | "flow", startIso: string, endIso: string, conversionMetricId: string): Promise<{ rows: MonthStat[]; raw?: any }> {
  const path = kind === "campaign" ? "/campaign-series-reports/" : "/flow-series-reports/";
  const body = {
    data: {
      type: kind === "campaign" ? "campaign-series-report" : "flow-series-report",
      attributes: {
        statistics: [...STATS],
        timeframe: { start: startIso, end: endIso },
        interval: "monthly",
        conversion_metric_id: conversionMetricId,
        filter: "equals(send_channel,'email')",
      },
    },
  };
  const j = await kFetch(path, { method: "POST", body: JSON.stringify(body) });
  const dates: string[] = j?.data?.attributes?.date_times ?? [];
  const results: any[] = j?.data?.attributes?.results ?? [];
  const byKey = new Map<string, MonthStat>();
  for (const r of results) {
    const id = String(r?.groupings?.campaign_id ?? r?.groupings?.flow_id ?? "");
    if (!id) continue;
    const s = r.statistics ?? {};
    dates.forEach((d, i) => {
      const n = (k: string) => Number((s[k] ?? [])[i] ?? 0) || 0;
      const key = `${monthKey(d)}|${id}`;
      const cur = byKey.get(key) ?? {
        month: monthKey(d), kind, entity_id: id,
        recipients: 0, delivered: 0, opens_unique: 0, clicks_unique: 0, bounced: 0, unsubscribes: 0, spam_complaints: 0, conversions: 0, conversion_value_cents: 0,
      };
      cur.recipients += n("recipients");
      cur.delivered += n("delivered");
      cur.opens_unique += n("opens_unique");
      cur.clicks_unique += n("clicks_unique");
      cur.bounced += n("bounced");
      cur.unsubscribes += n("unsubscribes");
      cur.spam_complaints += n("spam_complaints");
      cur.conversions += n("conversions");
      cur.conversion_value_cents += Math.round(n("conversion_value") * 100);
      byKey.set(key, cur);
    });
  }
  return { rows: [...byKey.values()].filter((r) => r.recipients > 0 || r.delivered > 0 || r.opens_unique > 0), raw: j };
}

/**
 * Values report for ONE calendar month (campaign-series-reports is not
 * available on this account, so campaigns are pulled a month at a time).
 * Every row lands on the month of `startIso`.
 */
export async function valuesReport(kind: "campaign" | "flow", startIso: string, endIso: string, conversionMetricId: string): Promise<{ rows: MonthStat[]; raw?: any }> {
  const path = kind === "campaign" ? "/campaign-values-reports/" : "/flow-values-reports/";
  const body = {
    data: {
      type: kind === "campaign" ? "campaign-values-report" : "flow-values-report",
      attributes: {
        statistics: [...STATS],
        timeframe: { start: startIso, end: endIso },
        conversion_metric_id: conversionMetricId,
        filter: "equals(send_channel,'email')",
      },
    },
  };
  const j = await kFetch(path, { method: "POST", body: JSON.stringify(body) });
  const results: any[] = j?.data?.attributes?.results ?? [];
  const month = monthKey(startIso);
  const byId = new Map<string, MonthStat>();
  for (const r of results) {
    const id = String(r?.groupings?.campaign_id ?? r?.groupings?.flow_id ?? "");
    if (!id) continue;
    const s = r.statistics ?? {};
    const n = (k: string) => Number(s[k] ?? 0) || 0;
    const cur = byId.get(id) ?? {
      month, kind, entity_id: id,
      recipients: 0, delivered: 0, opens_unique: 0, clicks_unique: 0, bounced: 0, unsubscribes: 0, spam_complaints: 0, conversions: 0, conversion_value_cents: 0,
    };
    cur.recipients += n("recipients"); cur.delivered += n("delivered"); cur.opens_unique += n("opens_unique"); cur.clicks_unique += n("clicks_unique");
    cur.bounced += n("bounced"); cur.unsubscribes += n("unsubscribes"); cur.spam_complaints += n("spam_complaints"); cur.conversions += n("conversions");
    cur.conversion_value_cents += Math.round(n("conversion_value") * 100);
    byId.set(id, cur);
  }
  return { rows: [...byId.values()].filter((r) => r.recipients > 0 || r.delivered > 0 || r.opens_unique > 0), raw: j };
}

/** Campaign id → {name, status, send_time} (email campaigns, incl. archived). */
export async function campaignNames(): Promise<Map<string, { name: string; status: string | null; send_time: string | null }>> {
  const out = new Map<string, { name: string; status: string | null; send_time: string | null }>();
  for (const archived of [false, true]) {
    let url: string | null =
      `/campaigns/?filter=${encodeURIComponent(`and(equals(messages.channel,'email'),equals(archived,${archived}))`)}&fields[campaign]=name,status,send_time,archived&page[size]=100`;
    for (let i = 0; url && i < 60; i++) {
      const j = await kFetch(url);
      for (const c of j.data ?? []) out.set(String(c.id), { name: c.attributes?.name ?? c.id, status: c.attributes?.status ?? null, send_time: c.attributes?.send_time ?? null });
      const next: string | null = j.links?.next ?? null;
      url = next ? next.replace(BASE, "") : null;
    }
  }
  return out;
}

export async function flowNames(): Promise<Map<string, { name: string; status: string | null }>> {
  const out = new Map<string, { name: string; status: string | null }>();
  let url: string | null = `/flows/?fields[flow]=name,status,archived&page[size]=50`;
  for (let i = 0; url && i < 60; i++) {
    const j = await kFetch(url);
    for (const f of j.data ?? []) out.set(String(f.id), { name: f.attributes?.name ?? f.id, status: f.attributes?.status ?? null });
    const next: string | null = j.links?.next ?? null;
    url = next ? next.replace(BASE, "") : null;
  }
  return out;
}

export async function conversionMetricId(): Promise<string> {
  const ids = await getMetricIds();
  const id = ids.get("Placed Order") ?? ids.get("Ordered Product");
  if (!id) throw new Error("Klaviyo 'Placed Order' metric not found");
  return id;
}

/** Pull one (kind, window) and upsert it, attaching names. */
export async function syncEmailStatsWindow(db: SupabaseClient, kind: "campaign" | "flow", startIso: string, endIso: string, names: Map<string, any>) {
  const metric = await conversionMetricId();
  // Campaigns: one month per call (values report). Flows: series over the window.
  const { rows } = kind === "campaign" ? await valuesReport(kind, startIso, endIso, metric) : await seriesReport(kind, startIso, endIso, metric);
  if (!rows.length) return { kind, startIso, endIso, rows: 0 };
  const payload = rows.map((r) => {
    const n = names.get(r.entity_id);
    return { ...r, name: n?.name ?? null, status: n?.status ?? null, send_time: n?.send_time ?? null, synced_at: new Date().toISOString() };
  });
  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await db.from("email_stats_monthly").upsert(payload.slice(i, i + 500), { onConflict: "month,kind,entity_id" });
    if (error) throw new Error(`email_stats_monthly upsert: ${error.message}`);
  }
  return { kind, startIso, endIso, rows: payload.length };
}
