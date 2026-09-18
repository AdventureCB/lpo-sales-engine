import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env, envOptional } from "./env";

/**
 * Google Ads API via the same OAuth client as the Gmail integration
 * (GOOGLE_CLIENT_ID/SECRET; scope adwords). The refresh token is stored in
 * crm_sync_state under `google_ads_oauth` by the /api/google-ads/connect
 * flow. Campaign-level daily spend/clicks/names feed ad_campaign_daily —
 * same table + surfaces as Meta.
 */

export const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
export const REDIRECT_PATH = "/api/google-ads/callback";
const STATE_KEY = "google_ads_oauth";
// The Ads API retires versions aggressively (v18-v21 all 404'd by 9/18/2026);
// probe newest-first and cache what works. Bump this list when these sunset.
const VERSIONS = ["v24", "v23", "v22"];

export function adsRedirectUri(): string {
  const base = envOptional("APP_URL") ?? "https://lpo-sales-engine.vercel.app";
  return `${base}${REDIRECT_PATH}`;
}

export function adsAuthUrl(state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env("GOOGLE_CLIENT_ID"));
  u.searchParams.set("redirect_uri", adsRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", ADS_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function adsExchangeCode(code: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: adsRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const tok = await res.json();
  if (!res.ok || !tok.refresh_token) throw new Error(`ads token exchange failed: ${JSON.stringify(tok).slice(0, 200)}`);
  return tok.refresh_token as string;
}

export async function saveAdsRefreshToken(db: SupabaseClient, refreshToken: string): Promise<void> {
  await db.from("crm_sync_state").upsert(
    { key: STATE_KEY, value: { refresh_token: refreshToken }, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

export function adsConfigured(): boolean {
  return Boolean(envOptional("GOOGLE_ADS_DEVELOPER_TOKEN") && envOptional("GOOGLE_ADS_CUSTOMER_ID"));
}

async function adsState(db: SupabaseClient): Promise<Record<string, any> | null> {
  const { data } = await db.from("crm_sync_state").select("value").eq("key", STATE_KEY).maybeSingle();
  return (data?.value as Record<string, any>) ?? null;
}

async function accessToken(db: SupabaseClient): Promise<string> {
  const st = await adsState(db);
  if (!st?.refresh_token) throw new Error("Google Ads not connected — visit /api/google-ads/connect");
  if (st.access_token && st.expires_at && Date.parse(st.expires_at) > Date.now() + 60_000) return st.access_token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: st.refresh_token,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  const tok = await res.json();
  if (!res.ok || !tok.access_token) throw new Error(`ads token refresh failed: ${JSON.stringify(tok).slice(0, 150)}`);
  const expires_at = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString();
  await db.from("crm_sync_state").upsert(
    { key: STATE_KEY, value: { ...st, access_token: tok.access_token, expires_at }, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  return tok.access_token as string;
}

export interface GoogleCampaignDay {
  campaignId: string;
  name: string;
  day: string;
  spendCents: number;
  clicks: number;
  impressions: number;
  imprShare: number | null; // search_impression_share (0-1); null for non-search
  lostIsBudget: number | null; // search_budget_lost_impression_share
  lostIsRank: number | null; // search_rank_lost_impression_share
}

/** Run a GAQL query via searchStream; probes API versions and caches the working
 * one. Returns the flattened result rows (across stream chunks). */
async function runGaql(db: SupabaseClient, query: string): Promise<any[]> {
  const token = await accessToken(db);
  const cid = env("GOOGLE_ADS_CUSTOMER_ID").replace(/-/g, "");
  const login = envOptional("GOOGLE_ADS_LOGIN_CUSTOMER_ID")?.replace(/-/g, "");
  const st = await adsState(db);
  const tryVersions = st?.api_version ? [st.api_version, ...VERSIONS.filter((v) => v !== st.api_version)] : VERSIONS;

  let lastErr = "";
  for (const v of tryVersions) {
    const r = await fetch(`https://googleads.googleapis.com/${v}/customers/${cid}/googleAds:searchStream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "developer-token": env("GOOGLE_ADS_DEVELOPER_TOKEN"),
        ...(login ? { "login-customer-id": login } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    const text = await r.text();
    if (!r.ok) {
      lastErr = `${v}: ${r.status} ${text.slice(0, 200)}`;
      if (r.status === 404 || /version/i.test(text)) continue; // retired version — try next
      throw new Error(`google ads ${lastErr}`);
    }
    if (st?.api_version !== v) {
      await db.from("crm_sync_state").upsert(
        { key: STATE_KEY, value: { ...(st ?? {}), api_version: v }, updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
    }
    const chunks = JSON.parse(text);
    const out: any[] = [];
    for (const chunk of Array.isArray(chunks) ? chunks : [chunks]) {
      for (const row of chunk?.results ?? []) out.push(row);
    }
    return out;
  }
  throw new Error(`google ads: no working API version (${lastErr})`);
}

/** Campaign daily (spend/clicks/impressions/impression-share) via GAQL. */
export async function googleCampaignDaily(
  db: SupabaseClient,
  since: string,
  until: string
): Promise<GoogleCampaignDay[]> {
  const query =
    `SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions, ` +
    `metrics.search_impression_share, metrics.search_budget_lost_impression_share, ` +
    `metrics.search_rank_lost_impression_share, segments.date ` +
    `FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`;
  // IS metrics are absent for non-search campaigns; Google also returns a
  // sentinel for "< 10%" — treat missing/negative as null (unknown).
  const rate = (v: unknown): number | null => {
    const n = Number(v);
    return v == null || !Number.isFinite(n) || n < 0 ? null : n;
  };
  const rows = await runGaql(db, query);
  return rows
    .map((row) => {
      const m = row.metrics ?? {};
      return {
        campaignId: String(row.campaign?.id ?? ""),
        name: String(row.campaign?.name ?? "").slice(0, 200),
        day: row.segments?.date ?? "",
        spendCents: Math.round(Number(m.costMicros ?? 0) / 10_000),
        clicks: Math.round(Number(m.clicks ?? 0)),
        impressions: Math.round(Number(m.impressions ?? 0)),
        imprShare: rate(m.searchImpressionShare),
        lostIsBudget: rate(m.searchBudgetLostImpressionShare),
        lostIsRank: rate(m.searchRankLostImpressionShare),
      } as GoogleCampaignDay;
    })
    .filter((x) => x.campaignId && x.day);
}

/**
 * gclid → campaign map from the click_view report. click_view REQUIRES a single
 * day per query and only covers the last ~90 days, so we loop day-by-day; one
 * bad day never kills the rest. Lets first-party Google clicks (which carry a
 * gclid but often an unusable utm_campaign) resolve to a real campaign for ROAS.
 */
export async function googleClickCampaigns(
  db: SupabaseClient,
  since: string,
  until: string
): Promise<{ gclid: string; campaignId: string; day: string }[]> {
  const out: { gclid: string; campaignId: string; day: string }[] = [];
  const start = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    try {
      const rows = await runGaql(
        db,
        `SELECT click_view.gclid, campaign.id, segments.date FROM click_view WHERE segments.date = '${day}'`
      );
      for (const row of rows) {
        const gclid = row.clickView?.gclid;
        const campaignId = row.campaign?.id ? String(row.campaign.id) : null;
        if (gclid && campaignId) out.push({ gclid: String(gclid), campaignId, day: row.segments?.date ?? day });
      }
    } catch {
      // click_view unavailable for this day (outside 90d window, or access) — skip.
    }
  }
  return out;
}
