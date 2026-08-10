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
    `?level=campaign&fields=campaign_id,campaign_name,spend,clicks` +
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
      });
    }
    url = d?.paging?.next ?? null;
  }
  return out;
}
