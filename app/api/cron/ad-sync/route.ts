import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Daily native ad sync (replaced Triple Whale 9/18 — TW account cancelled):
 *  1. Meta + Google campaign-level daily spend/clicks/names → ad_campaign_daily
 *     (re-pulls a few trailing days since platforms restate spend).
 *  2. Roll those campaigns up to channel-level → ad_spend (the table lead-cost
 *     reads for channel CPL). This used to come from TW's summary API; now it's
 *     the sum of the campaigns we own the feeds for (facebook + google).
 * Attribution is first-party (web_touches / attr.js) — no pixel dependency here.
 * ?spendDays=N (default 3) controls both the pull window and the rollup window;
 * larger values do a one-off backfill.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const spendDays = Math.min(Number(params.get("spendDays") ?? 3) || 3, 120);
  const db = supabaseAdmin();

  const laDay = (offset: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.now() - offset * 86_400_000));
  const since = laDay(spendDays - 1);
  const until = laDay(0);

  // ── 1a. Meta campaign-level daily ──
  let campaignRows = 0;
  const campaignErrors: string[] = [];
  try {
    const { metaConfigured, metaCampaignDaily } = await import("@/lib/meta-ads");
    if (metaConfigured()) {
      const days = await metaCampaignDaily(since, until);
      for (const c of days) {
        await db.from("ad_campaign_daily").upsert(
          {
            channel: "facebook", campaign_id: c.campaignId, day: c.day, name: c.name,
            spend_cents: c.spendCents, clicks: c.clicks, impressions: c.impressions,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "channel,campaign_id,day" }
        );
        campaignRows++;
      }
    }
  } catch (e) {
    campaignErrors.push(`meta: ${e instanceof Error ? e.message : "failed"}`);
  }

  // ── 1b. Google campaign-level daily (same table/surfaces as Meta) ──
  try {
    const { adsConfigured, googleCampaignDaily } = await import("@/lib/google-ads");
    if (adsConfigured()) {
      const days = await googleCampaignDaily(db, since, until);
      for (const c of days) {
        await db.from("ad_campaign_daily").upsert(
          {
            channel: "google", campaign_id: c.campaignId, day: c.day, name: c.name,
            spend_cents: c.spendCents, clicks: c.clicks, impressions: c.impressions,
            impr_share: c.imprShare, lost_is_budget: c.lostIsBudget, lost_is_rank: c.lostIsRank,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "channel,campaign_id,day" }
        );
        campaignRows++;
      }
    } else {
      campaignErrors.push("google: not connected (reconnect at /api/google-ads/connect)");
    }
  } catch (e) {
    campaignErrors.push(`google: ${e instanceof Error ? e.message : "failed"}`);
  }

  // ── 1c. Google gclid → campaign map (click_view) for per-campaign ROAS ──
  let clickRows = 0;
  try {
    const { adsConfigured, googleClickCampaigns } = await import("@/lib/google-ads");
    if (adsConfigured()) {
      const clicks = await googleClickCampaigns(db, since, until);
      for (let i = 0; i < clicks.length; i += 500) {
        const batch = clicks.slice(i, i + 500).map((c) => ({
          gclid: c.gclid, campaign_id: c.campaignId, day: c.day, updated_at: new Date().toISOString(),
        }));
        await db.from("google_click_map").upsert(batch, { onConflict: "gclid" });
        clickRows += batch.length;
      }
    }
  } catch (e) {
    campaignErrors.push(`google clicks: ${e instanceof Error ? e.message : "failed"}`);
  }

  // ── 2. Roll campaigns up to channel-level ad_spend ──
  // Channel spend/clicks = the sum of that channel's campaigns for the day.
  // (Replaces TW's summary API; honest platform spend for the feeds we own.)
  let spendRows = 0;
  const spendErrors: string[] = [];
  try {
    const { data: camp } = await db
      .from("ad_campaign_daily")
      .select("channel, day, spend_cents, clicks")
      .gte("day", since);
    const agg = new Map<string, { channel: string; day: string; spend: number; clicks: number }>();
    for (const r of camp ?? []) {
      const k = `${r.day}|${r.channel}`;
      const cur = agg.get(k) ?? { channel: r.channel as string, day: r.day as string, spend: 0, clicks: 0 };
      cur.spend += (r.spend_cents as number) ?? 0;
      cur.clicks += (r.clicks as number) ?? 0;
      agg.set(k, cur);
    }
    for (const v of agg.values()) {
      await db.from("ad_spend").upsert(
        { day: v.day, channel: v.channel, spend_cents: v.spend, clicks: v.clicks, updated_at: new Date().toISOString() },
        { onConflict: "day,channel" }
      );
      spendRows++;
    }
  } catch (e) {
    spendErrors.push(e instanceof Error ? e.message : "rollup failed");
  }

  return NextResponse.json({
    ok: true,
    spendDays,
    campaignRows,
    clickRows,
    spendRows,
    ...(campaignErrors.length ? { campaignErrors } : {}),
    ...(spendErrors.length ? { spendErrors } : {}),
  });
}
