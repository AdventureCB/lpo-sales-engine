import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { attributeDeals } from "@/lib/campaign-roas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ads inside one campaign (the "expand a campaign" drill on the Google/Meta
 * pages), grouped by ad set / ad group, over the same window + comparison
 * semantics as the campaigns API:
 *   ?channel=google|meta&campaignId=… and ?days=N or ?start&end ; ?compare=prev
 * Platform metrics from ad_ad_daily; leads/won/revenue/ROAS per AD from
 * first-party attribution (Meta: ad id in utm_content; Google: click_view map).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const raw = (p.get("channel") ?? "").toLowerCase();
  const channel = raw === "meta" ? "facebook" : raw;
  const campaignId = p.get("campaignId") ?? "";
  if (!["google", "facebook"].includes(channel) || !campaignId) {
    return NextResponse.json({ error: "channel (google|meta) and campaignId required" }, { status: 400 });
  }

  const laToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const laDay = (o: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() - o * 86_400_000));
  const isDay = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  let start: string, end: string;
  if (isDay(p.get("start")) && isDay(p.get("end"))) {
    start = p.get("start")!; end = p.get("end")!;
    if (start > end) [start, end] = [end, start];
  } else {
    const days = Math.min(Math.max(Number(p.get("days") ?? 30) || 30, 1), 365);
    start = laDay(days - 1); end = laToday;
  }
  const spanDays = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  const wantCompare = p.get("compare") === "prev";
  const prevEnd = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(Date.parse(`${start}T00:00:00Z`) - 86_400_000);
  const prevStart = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(Date.parse(`${start}T00:00:00Z`) - spanDays * 86_400_000);

  const db = supabaseAdmin();
  const cur = await period(db, channel, campaignId, start, end);
  const prev = wantCompare ? await period(db, channel, campaignId, prevStart, prevEnd) : null;

  const groups = cur.groups.map((g) => ({
    ...g,
    ads: g.ads.map((a) => ({ ...a, prev: prev?.byAd.get(a.adId) ?? null })),
  }));
  return NextResponse.json({ channel: channel === "google" ? "google" : "meta", campaignId, start, end, spanDays, compare: wantCompare ? { start: prevStart, end: prevEnd } : null, groups, totals: cur.totals });
}

interface AdRow {
  adId: string; name: string; groupId: string | null; groupName: string | null;
  spendCents: number; clicks: number; impressions: number;
  ctr: number | null; cpcCents: number | null;
  convValueCents: number; conversions: number; platformRoas: number | null;
  leads: number; wonDeals: number; revenueCents: number; roas: number | null;
}

async function period(db: SupabaseClient, channel: string, campaignId: string, startDay: string, endDay: string) {
  const { data } = await db
    .from("ad_ad_daily")
    .select("ad_id, name, group_id, group_name, day, spend_cents, clicks, impressions, conv_value_cents, conversions")
    .eq("channel", channel)
    .eq("campaign_id", campaignId)
    .gte("day", startDay)
    .lte("day", endDay)
    .limit(20000);

  type Acc = AdRow & { lastDay: string };
  const acc = new Map<string, Acc>();
  for (const r of data ?? []) {
    const id = String(r.ad_id);
    const a = acc.get(id) ?? {
      adId: id, name: r.name ?? id, groupId: r.group_id ? String(r.group_id) : null, groupName: r.group_name ?? null, lastDay: "",
      spendCents: 0, clicks: 0, impressions: 0, ctr: null, cpcCents: null, convValueCents: 0, conversions: 0, platformRoas: null,
      leads: 0, wonDeals: 0, revenueCents: 0, roas: null,
    };
    a.spendCents += Number(r.spend_cents ?? 0);
    a.clicks += Number(r.clicks ?? 0);
    a.impressions += Number(r.impressions ?? 0);
    a.convValueCents += Number(r.conv_value_cents ?? 0);
    a.conversions += Number(r.conversions ?? 0);
    if ((r.day as string) > a.lastDay) { a.lastDay = r.day as string; a.name = r.name ?? a.name; a.groupName = r.group_name ?? a.groupName; }
    acc.set(id, a);
  }

  // First-party revenue per ad (same resolver as campaigns, keyed by ad id).
  const { created, won } = await attributeDeals(db, `${startDay}T00:00:00Z`, `${endDay}T23:59:59.999Z`);
  for (const d of created) {
    if (d.attr?.channel === channel && d.attr.adId) { const a = acc.get(d.attr.adId); if (a) a.leads += 1; }
  }
  for (const d of won) {
    if (d.attr?.channel === channel && d.attr.adId) { const a = acc.get(d.attr.adId); if (a) { a.wonDeals += 1; a.revenueCents += d.valueCents; } }
  }

  const rows: AdRow[] = [...acc.values()].map((a) => ({
    adId: a.adId, name: a.name, groupId: a.groupId, groupName: a.groupName,
    spendCents: a.spendCents, clicks: a.clicks, impressions: a.impressions,
    ctr: a.impressions > 0 ? a.clicks / a.impressions : null,
    cpcCents: a.clicks > 0 ? Math.round(a.spendCents / a.clicks) : null,
    convValueCents: a.convValueCents, conversions: a.conversions,
    platformRoas: a.spendCents > 0 && a.convValueCents > 0 ? a.convValueCents / a.spendCents : null,
    leads: a.leads, wonDeals: a.wonDeals, revenueCents: a.revenueCents,
    roas: a.spendCents > 0 ? a.revenueCents / a.spendCents : null,
  }));
  const byAd = new Map(rows.map((r) => [r.adId, r]));

  // Group by ad set / ad group, biggest spend first.
  const groupMap = new Map<string, { groupId: string | null; groupName: string | null; ads: AdRow[]; spendCents: number }>();
  for (const r of rows) {
    const k = r.groupId ?? "";
    const g = groupMap.get(k) ?? { groupId: r.groupId, groupName: r.groupName, ads: [], spendCents: 0 };
    g.ads.push(r); g.spendCents += r.spendCents;
    groupMap.set(k, g);
  }
  const groups = [...groupMap.values()]
    .map((g) => ({ ...g, ads: g.ads.sort((a, b) => b.spendCents - a.spendCents) }))
    .sort((a, b) => b.spendCents - a.spendCents);

  const t = rows.reduce(
    (s, r) => { s.spendCents += r.spendCents; s.clicks += r.clicks; s.impressions += r.impressions; s.convValueCents += r.convValueCents; s.leads += r.leads; s.wonDeals += r.wonDeals; s.revenueCents += r.revenueCents; return s; },
    { spendCents: 0, clicks: 0, impressions: 0, convValueCents: 0, leads: 0, wonDeals: 0, revenueCents: 0 }
  );
  const totals = { ...t, roas: t.spendCents > 0 ? t.revenueCents / t.spendCents : null, platformRoas: t.spendCents > 0 && t.convValueCents > 0 ? t.convValueCents / t.spendCents : null };
  return { groups, byAd, totals };
}
