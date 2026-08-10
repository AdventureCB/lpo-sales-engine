import "server-only";
import { envOptional } from "./env";

/**
 * Triple Whale public API client (read-only scopes). Two surfaces:
 *  - summary-page/get-data: channel-level metrics; called per-day for clean
 *    daily spend (values.current for a single-day window = that day).
 *  - attribution/get-orders-with-journeys-v2: per-order pixel journeys with
 *    first/last click (source + campaignId).
 */

const BASE = "https://api.triplewhale.com/api/v2";
export const TW_SHOP = "lone-peak-overland.myshopify.com";

// metricId → our channel slug. Only these are ingested; extend as channels
// get turned on (anything not listed is ignored).
export const SPEND_METRICS: Record<string, string> = {
  fb_ads_spend: "facebook",
  ga_adCost: "google",
  openaiAdsSpend: "chatgpt",
  tiktok_spend: "tiktok",
  totalSnapchatSpend: "snapchat",
  pinterestSpend: "pinterest",
  bingAdSpend: "microsoft",
  redditSpend: "reddit",
  linkedinSpend: "linkedin",
  twitter_spend: "twitter",
};

function key(): string {
  const k = envOptional("TW_API_KEY");
  if (!k) throw new Error("TW_API_KEY not configured");
  return k;
}

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "x-api-key": key(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`TW ${path} ${r.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`TW ${path}: non-JSON response: ${text.slice(0, 120)}`);
  }
}

/** Channel spend for one calendar day (shop timezone). */
export async function twDailySpend(day: string): Promise<{ channel: string; spendCents: number }[]> {
  const d = await post("/summary-page/get-data", {
    shopDomain: TW_SHOP,
    period: { start: day, end: day },
    // Required field; the shop-local current hour (matters only when the
    // window touches today — partial-day metrics are cut at this hour).
    todayHour: Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(new Date())
    ) % 24,
  });
  const out: { channel: string; spendCents: number }[] = [];
  for (const m of d?.metrics ?? []) {
    const channel = SPEND_METRICS[m?.metricId ?? ""];
    if (!channel) continue;
    const v = Number(m?.values?.current ?? 0);
    if (Number.isFinite(v)) out.push({ channel, spendCents: Math.round(v * 100) });
  }
  return out;
}

export interface TwOrderJourney {
  order_id: string;
  order_name?: string;
  customer_id?: number;
  created_at?: string;
  total_price?: number;
  attribution?: Record<string, any>;
  journey?: { time?: string; event?: string; path?: string; productId?: number }[];
}

/** One page of orders-with-journeys (pageSize ≤ 100). */
export async function twOrdersWithJourneys(
  startIso: string,
  endIso: string,
  page: number,
  pageSize = 100
): Promise<{ orders: TwOrderJourney[]; count: number }> {
  const d = await post("/attribution/get-orders-with-journeys-v2", {
    shop: TW_SHOP,
    startDate: startIso,
    endDate: endIso,
    page,
    pageSize,
  });
  return { orders: d?.ordersWithJourneys ?? [], count: Number(d?.count ?? 0) };
}
