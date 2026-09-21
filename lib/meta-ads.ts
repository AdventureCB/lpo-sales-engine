import "server-only";
import { envOptional } from "./env";

/**
 * Meta Marketing API (system-user token, ads_read): campaign-level daily
 * spend/clicks/names. Feeds ad_campaign_daily for campaign-name resolution
 * and per-campaign CPC pricing.
 */

const V = "v21.0";

export interface CampaignDay {
  campaignId: string;
  name: string;
  day: string; // YYYY-MM-DD
  spendCents: number;
  clicks: number;
  impressions: number;
  convValueCents: number; // platform-reported purchase value
  conversions: number; // platform-reported purchase count
}

/** Pull the purchase metric from a Meta actions/action_values array. */
function purchaseVal(arr: any): number {
  const list: any[] = Array.isArray(arr) ? arr : [];
  const pick = (type: string) => list.find((a) => a?.action_type === type);
  const row = pick("omni_purchase") ?? pick("offsite_conversion.fb_pixel_purchase") ?? pick("purchase");
  return row ? Number(row.value ?? 0) : 0;
}

export function metaConfigured(): boolean {
  return !!envOptional("META_ADS_TOKEN") && !!envOptional("META_AD_ACCOUNT");
}

export async function metaCampaignDaily(since: string, until: string): Promise<CampaignDay[]> {
  const token = envOptional("META_ADS_TOKEN");
  const account = envOptional("META_AD_ACCOUNT");
  if (!token || !account) throw new Error("META_ADS_TOKEN / META_AD_ACCOUNT not configured");

  const out: CampaignDay[] = [];
  let url =
    `https://graph.facebook.com/${V}/${account}/insights` +
    `?level=campaign&fields=campaign_id,campaign_name,spend,clicks,impressions,actions,action_values` +
    `&time_increment=1&limit=500` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
    `&access_token=${encodeURIComponent(token)}`;

  for (let page = 0; page < 20 && url; page++) {
    const r = await fetch(url);
    const d = await r.json();
    if (!r.ok) throw new Error(`meta insights ${r.status}: ${JSON.stringify(d?.error ?? d).slice(0, 200)}`);
    for (const row of d?.data ?? []) {
      if (!row?.campaign_id || !row?.date_start) continue;
      out.push({
        campaignId: String(row.campaign_id),
        name: String(row.campaign_name ?? "").slice(0, 200),
        day: row.date_start,
        spendCents: Math.round(Number(row.spend ?? 0) * 100),
        clicks: Math.round(Number(row.clicks ?? 0)),
        impressions: Math.round(Number(row.impressions ?? 0)),
        convValueCents: Math.round(purchaseVal(row.action_values) * 100),
        conversions: Math.round(purchaseVal(row.actions)),
      });
    }
    url = d?.paging?.next ?? null;
  }
  return out;
}

export interface AdDay {
  adId: string;
  name: string;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string;
  day: string;
  spendCents: number;
  clicks: number;
  impressions: number;
  convValueCents: number;
  conversions: number;
}

/** Ad-level daily metrics (ad within ad set within campaign) — feeds ad_ad_daily. */
export async function metaAdDaily(since: string, until: string): Promise<AdDay[]> {
  const token = envOptional("META_ADS_TOKEN");
  const account = envOptional("META_AD_ACCOUNT");
  if (!token || !account) throw new Error("META_ADS_TOKEN / META_AD_ACCOUNT not configured");

  const out: AdDay[] = [];
  let url =
    `https://graph.facebook.com/${V}/${account}/insights` +
    `?level=ad&fields=ad_id,ad_name,adset_id,adset_name,campaign_id,spend,clicks,impressions,actions,action_values` +
    `&time_increment=1&limit=500` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
    `&access_token=${encodeURIComponent(token)}`;

  for (let page = 0; page < 40 && url; page++) {
    const r = await fetch(url);
    const d = await r.json();
    if (!r.ok) throw new Error(`meta ad insights ${r.status}: ${JSON.stringify(d?.error ?? d).slice(0, 200)}`);
    for (const row of d?.data ?? []) {
      if (!row?.ad_id || !row?.date_start) continue;
      out.push({
        adId: String(row.ad_id),
        name: String(row.ad_name ?? "").slice(0, 200),
        adsetId: row.adset_id ? String(row.adset_id) : null,
        adsetName: row.adset_name ? String(row.adset_name).slice(0, 200) : null,
        campaignId: String(row.campaign_id ?? ""),
        day: row.date_start,
        spendCents: Math.round(Number(row.spend ?? 0) * 100),
        clicks: Math.round(Number(row.clicks ?? 0)),
        impressions: Math.round(Number(row.impressions ?? 0)),
        convValueCents: Math.round(purchaseVal(row.action_values) * 100),
        conversions: Math.round(purchaseVal(row.actions)),
      });
    }
    url = d?.paging?.next ?? null;
  }
  return out;
}
