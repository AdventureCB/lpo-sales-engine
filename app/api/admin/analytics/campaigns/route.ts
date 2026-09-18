import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { campaignRevenue } from "@/lib/campaign-roas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-campaign performance + ROAS for one channel over a day window, with an
 * optional period-over-period comparison.
 *   ?channel=google|meta  and either ?days=N  or ?start=YYYY-MM-DD&end=YYYY-MM-DD
 *   ?compare=prev  → also returns the immediately-preceding equal-length period,
 *                    with per-row + totals deltas.
 * Spend/clicks/impressions/IS come from ad_campaign_daily; leads/won/revenue from
 * first-party attribution (lib/campaign-roas). IS is impression-weighted (a rate).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const raw = (p.get("channel") ?? "").toLowerCase();
  const channel = raw === "meta" ? "facebook" : raw;
  if (!["google", "facebook"].includes(channel)) {
    return NextResponse.json({ error: "channel must be google or meta" }, { status: 400 });
  }
  const isGoogle = channel === "google";

  const laToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const laDay = (offset: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() - offset * 86_400_000));
  const isDay = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

  let start: string, end: string;
  if (isDay(p.get("start")) && isDay(p.get("end"))) {
    start = p.get("start")!;
    end = p.get("end")!;
    if (start > end) [start, end] = [end, start];
  } else {
    const days = Math.min(Math.max(Number(p.get("days") ?? 30) || 30, 1), 365);
    start = laDay(days - 1);
    end = laToday;
  }
  const spanDays = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  const wantCompare = p.get("compare") === "prev";
  // Previous equal-length window ends the day before `start`.
  const prevEnd = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date(Date.parse(`${start}T00:00:00Z`) - 86_400_000));
  const prevStart = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(Date.parse(`${start}T00:00:00Z`) - spanDays * 86_400_000);

  const db = supabaseAdmin();
  const cur = await periodReport(db, channel, isGoogle, start, end);
  const prev = wantCompare ? await periodReport(db, channel, isGoogle, prevStart, prevEnd) : null;

  const rows = cur.rows.map((r) => ({
    ...r,
    prev: prev?.byId.get(r.campaignId) ?? null,
  }));

  return NextResponse.json({
    channel: isGoogle ? "google" : "meta",
    start, end, spanDays,
    compare: wantCompare ? { start: prevStart, end: prevEnd } : null,
    rows,
    totals: cur.totals,
    prevTotals: prev?.totals ?? null,
  });
}

interface CampRow {
  campaignId: string; name: string;
  spendCents: number; clicks: number; impressions: number;
  ctr: number | null; cpcCents: number | null; cpmCents: number | null;
  imprShare: number | null; lostIsBudget: number | null; lostIsRank: number | null;
  leads: number; wonDeals: number; revenueCents: number;
  roas: number | null; cplCents: number | null; cacCents: number | null;
}

async function periodReport(
  db: SupabaseClient, channel: string, isGoogle: boolean, startDay: string, endDay: string
): Promise<{ rows: CampRow[]; byId: Map<string, CampRow>; totals: any }> {
  const { data } = await db
    .from("ad_campaign_daily")
    .select("campaign_id, name, day, spend_cents, clicks, impressions, impr_share, lost_is_budget, lost_is_rank")
    .eq("channel", channel)
    .gte("day", startDay)
    .lte("day", endDay)
    .limit(20000);

  type Acc = {
    campaignId: string; name: string; lastDay: string;
    spendCents: number; clicks: number; impressions: number;
    isNum: number; isDen: number; budNum: number; budDen: number; rankNum: number; rankDen: number;
  };
  const acc = new Map<string, Acc>();
  for (const r of data ?? []) {
    const id = String(r.campaign_id);
    const a = acc.get(id) ?? { campaignId: id, name: r.name ?? id, lastDay: "", spendCents: 0, clicks: 0, impressions: 0, isNum: 0, isDen: 0, budNum: 0, budDen: 0, rankNum: 0, rankDen: 0 };
    const impr = Number(r.impressions ?? 0);
    a.spendCents += Number(r.spend_cents ?? 0);
    a.clicks += Number(r.clicks ?? 0);
    a.impressions += impr;
    if ((r.day as string) > a.lastDay) { a.lastDay = r.day as string; a.name = r.name ?? a.name; }
    const wt = (rate: unknown, addN: (n: number) => void, addD: (n: number) => void) => {
      if (rate == null) return; const n = Number(rate); if (!Number.isFinite(n)) return; addN(n * impr); addD(impr);
    };
    wt(r.impr_share, (n) => (a.isNum += n), (n) => (a.isDen += n));
    wt(r.lost_is_budget, (n) => (a.budNum += n), (n) => (a.budDen += n));
    wt(r.lost_is_rank, (n) => (a.rankNum += n), (n) => (a.rankDen += n));
    acc.set(id, a);
  }

  // Revenue attribution for this window, filtered to this channel.
  const rev = await campaignRevenue(db, `${startDay}T00:00:00Z`, `${endDay}T23:59:59.999Z`);
  const revByCampaign = new Map<string, { leads: number; wonDeals: number; wonValueCents: number }>();
  for (const [key, v] of rev) {
    const [ch, cid] = key.split("|");
    if (ch !== channel) continue;
    revByCampaign.set(cid, v); // cid "" = channel-known, campaign-unresolved
  }

  const rate = (num: number, den: number) => (den > 0 ? num / den : null);
  const ids = new Set<string>([...acc.keys(), ...[...revByCampaign.keys()].filter((k) => k !== "")]);
  const rows: CampRow[] = [];
  for (const id of ids) {
    const a = acc.get(id);
    const r = revByCampaign.get(id) ?? { leads: 0, wonDeals: 0, wonValueCents: 0 };
    const spend = a?.spendCents ?? 0;
    rows.push({
      campaignId: id,
      name: a?.name ?? id,
      spendCents: spend,
      clicks: a?.clicks ?? 0,
      impressions: a?.impressions ?? 0,
      ctr: a && a.impressions > 0 ? a.clicks / a.impressions : null,
      cpcCents: a && a.clicks > 0 ? Math.round(spend / a.clicks) : null,
      cpmCents: a && a.impressions > 0 ? Math.round((spend / a.impressions) * 1000) : null,
      imprShare: isGoogle && a ? rate(a.isNum, a.isDen) : null,
      lostIsBudget: isGoogle && a ? rate(a.budNum, a.budDen) : null,
      lostIsRank: isGoogle && a ? rate(a.rankNum, a.rankDen) : null,
      leads: r.leads,
      wonDeals: r.wonDeals,
      revenueCents: r.wonValueCents,
      roas: spend > 0 ? r.wonValueCents / spend : null,
      cplCents: r.leads > 0 && spend > 0 ? Math.round(spend / r.leads) : null,
      cacCents: r.wonDeals > 0 && spend > 0 ? Math.round(spend / r.wonDeals) : null,
    });
  }
  rows.sort((a, b) => b.spendCents - a.spendCents || b.revenueCents - a.revenueCents);

  // Channel-known but campaign-unresolved revenue → a pseudo-row so it's visible.
  const unresolved = revByCampaign.get("");
  if (unresolved && (unresolved.leads > 0 || unresolved.wonDeals > 0)) {
    rows.push({
      campaignId: "__unresolved__", name: "(campaign not resolved)",
      spendCents: 0, clicks: 0, impressions: 0, ctr: null, cpcCents: null, cpmCents: null,
      imprShare: null, lostIsBudget: null, lostIsRank: null,
      leads: unresolved.leads, wonDeals: unresolved.wonDeals, revenueCents: unresolved.wonValueCents,
      roas: null, cplCents: null, cacCents: null,
    });
  }

  const byId = new Map(rows.map((r) => [r.campaignId, r]));
  const t = rows.reduce(
    (s, r) => { s.spendCents += r.spendCents; s.clicks += r.clicks; s.impressions += r.impressions; s.leads += r.leads; s.wonDeals += r.wonDeals; s.revenueCents += r.revenueCents; return s; },
    { spendCents: 0, clicks: 0, impressions: 0, leads: 0, wonDeals: 0, revenueCents: 0 }
  );
  const totals = {
    ...t,
    ctr: t.impressions > 0 ? t.clicks / t.impressions : null,
    cpcCents: t.clicks > 0 ? Math.round(t.spendCents / t.clicks) : null,
    cpmCents: t.impressions > 0 ? Math.round((t.spendCents / t.impressions) * 1000) : null,
    roas: t.spendCents > 0 ? t.revenueCents / t.spendCents : null,
    cplCents: t.leads > 0 && t.spendCents > 0 ? Math.round(t.spendCents / t.leads) : null,
    cacCents: t.wonDeals > 0 && t.spendCents > 0 ? Math.round(t.spendCents / t.wonDeals) : null,
  };
  return { rows, byId, totals };
}
