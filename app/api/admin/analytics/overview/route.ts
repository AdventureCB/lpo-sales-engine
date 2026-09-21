import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { attributeDeals } from "@/lib/campaign-roas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cross-channel analytics overview — fully first-party (no Triple Whale).
 *   ?days=N  or  ?start=YYYY-MM-DD&end=YYYY-MM-DD ; ?compare=prev
 * Per channel: spend (native rollup), PLATFORM-reported conv value + ROAS (what
 * Google/Meta claim), and FIRST-PARTY CRM ROAS (leads/won/revenue attributed
 * from our own click data). Plus a daily spend trend for the window.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const p = new URL(req.url).searchParams;
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
  const cur = await period(db, start, end, true);
  const prev = wantCompare ? await period(db, prevStart, prevEnd, false) : null;

  const channels = cur.channels.map((c) => ({ ...c, prev: prev?.byChannel.get(c.channel) ?? null }));

  return NextResponse.json({
    start, end, spanDays,
    compare: wantCompare ? { start: prevStart, end: prevEnd } : null,
    channels,
    totals: cur.totals,
    prevTotals: prev?.totals ?? null,
    trend: cur.trend,
  });
}

interface Chan {
  channel: string; spendCents: number;
  convValueCents: number; conversions: number; platformRoas: number | null;
  leads: number; wonDeals: number; revenueCents: number;
  firstPartyRoas: number | null; cplCents: number | null; cacCents: number | null;
}

async function period(db: SupabaseClient, startDay: string, endDay: string, withTrend: boolean) {
  // Spend (native channel rollup) from ad_spend; platform conv value from campaigns.
  const [{ data: spend }, { data: camp }] = await Promise.all([
    db.from("ad_spend").select("day, channel, spend_cents").gte("day", startDay).lte("day", endDay).limit(20000),
    db.from("ad_campaign_daily").select("day, channel, conv_value_cents, conversions").gte("day", startDay).lte("day", endDay).limit(20000),
  ]);

  const spendByChannel = new Map<string, number>();
  const trendMap = new Map<string, Record<string, number>>(); // day -> {channel: cents}
  for (const r of spend ?? []) {
    spendByChannel.set(r.channel, (spendByChannel.get(r.channel) ?? 0) + (r.spend_cents ?? 0));
    if (withTrend) {
      const row = trendMap.get(r.day) ?? {};
      row[r.channel] = (row[r.channel] ?? 0) + (r.spend_cents ?? 0);
      trendMap.set(r.day, row);
    }
  }
  const convByChannel = new Map<string, { value: number; n: number }>();
  for (const r of camp ?? []) {
    const c = convByChannel.get(r.channel) ?? { value: 0, n: 0 };
    c.value += Number(r.conv_value_cents ?? 0);
    c.n += Number(r.conversions ?? 0);
    convByChannel.set(r.channel, c);
  }

  // First-party revenue attribution (shared cached resolver), rolled up to
  // channel — plus attributed won revenue per day for the trend line.
  const { created, won } = await attributeDeals(db, `${startDay}T00:00:00Z`, `${endDay}T23:59:59.999Z`);
  const fpByChannel = new Map<string, { leads: number; won: number; value: number }>();
  const bump = (ch: string, patch: { leads?: number; won?: number; value?: number }) => {
    const cur = fpByChannel.get(ch) ?? { leads: 0, won: 0, value: 0 };
    cur.leads += patch.leads ?? 0; cur.won += patch.won ?? 0; cur.value += patch.value ?? 0;
    fpByChannel.set(ch, cur);
  };
  const laDayOf = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(iso)) : null;
  const revenueByDay = new Map<string, number>();
  for (const d of created) if (d.attr?.channel) bump(d.attr.channel, { leads: 1 });
  for (const d of won) {
    if (!d.attr?.channel) continue;
    bump(d.attr.channel, { won: 1, value: d.valueCents });
    if (withTrend) {
      const day = laDayOf(d.at);
      if (day) revenueByDay.set(day, (revenueByDay.get(day) ?? 0) + d.valueCents);
    }
  }

  const allChannels = new Set<string>([...spendByChannel.keys(), ...convByChannel.keys(), ...fpByChannel.keys()]);
  const channels: Chan[] = [...allChannels]
    .map((channel) => {
      const spendCents = spendByChannel.get(channel) ?? 0;
      const conv = convByChannel.get(channel) ?? { value: 0, n: 0 };
      const fp = fpByChannel.get(channel) ?? { leads: 0, won: 0, value: 0 };
      return {
        channel, spendCents,
        convValueCents: conv.value, conversions: conv.n,
        platformRoas: spendCents > 0 && conv.value > 0 ? conv.value / spendCents : null,
        leads: fp.leads, wonDeals: fp.won, revenueCents: fp.value,
        firstPartyRoas: spendCents > 0 ? fp.value / spendCents : null,
        cplCents: fp.leads > 0 && spendCents > 0 ? Math.round(spendCents / fp.leads) : null,
        cacCents: fp.won > 0 && spendCents > 0 ? Math.round(spendCents / fp.won) : null,
      };
    })
    .filter((c) => c.spendCents > 0 || c.leads > 0 || c.revenueCents > 0)
    .sort((a, b) => b.spendCents - a.spendCents);

  const byChannel = new Map(channels.map((c) => [c.channel, c]));
  const t = channels.reduce(
    (s, c) => { s.spendCents += c.spendCents; s.convValueCents += c.convValueCents; s.leads += c.leads; s.wonDeals += c.wonDeals; s.revenueCents += c.revenueCents; return s; },
    { spendCents: 0, convValueCents: 0, leads: 0, wonDeals: 0, revenueCents: 0 }
  );
  const totals = {
    ...t,
    platformRoas: t.spendCents > 0 && t.convValueCents > 0 ? t.convValueCents / t.spendCents : null,
    firstPartyRoas: t.spendCents > 0 ? t.revenueCents / t.spendCents : null,
    cplCents: t.leads > 0 && t.spendCents > 0 ? Math.round(t.spendCents / t.leads) : null,
    cacCents: t.wonDeals > 0 && t.spendCents > 0 ? Math.round(t.spendCents / t.wonDeals) : null,
  };

  // Trend = every day with spend OR attributed revenue, in order.
  const trend = withTrend
    ? [...new Set([...trendMap.keys(), ...revenueByDay.keys()])]
        .sort()
        .map((day) => ({ day, byChannel: trendMap.get(day) ?? {}, revenueCents: revenueByDay.get(day) ?? 0 }))
    : [];

  return { channels, byChannel, totals, trend };
}
