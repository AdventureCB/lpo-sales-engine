import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-campaign platform metrics for one channel over a day window, from
 * ad_campaign_daily. Spend/clicks/impressions sum; impression share is a RATE
 * so it's impression-weighted across the window (never summed). ROAS/revenue is
 * a later phase — this is the platform-performance view.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const days = Math.min(Math.max(Number(p.get("days") ?? 30) || 30, 1), 365);
  // Accept "meta" as an alias for the stored "facebook" channel slug.
  const raw = (p.get("channel") ?? "").toLowerCase();
  const channel = raw === "meta" ? "facebook" : raw;
  if (!["google", "facebook"].includes(channel)) {
    return NextResponse.json({ error: "channel must be google or meta" }, { status: 400 });
  }
  const isGoogle = channel === "google";

  const db = supabaseAdmin();
  const sinceDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" })
    .format(new Date(Date.now() - (days - 1) * 86_400_000));

  const { data, error } = await db
    .from("ad_campaign_daily")
    .select("campaign_id, name, day, spend_cents, clicks, impressions, impr_share, lost_is_budget, lost_is_rank")
    .eq("channel", channel)
    .gte("day", sinceDay)
    .limit(20000);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  type Acc = {
    campaignId: string; name: string;
    spendCents: number; clicks: number; impressions: number;
    // impression-weighted rate accumulators (numerator = Σ rate·impr, denom = Σ impr where rate present)
    isNum: number; isDen: number; budNum: number; budDen: number; rankNum: number; rankDen: number;
    days: number; lastDay: string;
  };
  const byId = new Map<string, Acc>();
  for (const r of data ?? []) {
    const id = String(r.campaign_id);
    const a = byId.get(id) ?? {
      campaignId: id, name: r.name ?? id,
      spendCents: 0, clicks: 0, impressions: 0,
      isNum: 0, isDen: 0, budNum: 0, budDen: 0, rankNum: 0, rankDen: 0, days: 0, lastDay: "",
    };
    const impr = Number(r.impressions ?? 0);
    a.spendCents += Number(r.spend_cents ?? 0);
    a.clicks += Number(r.clicks ?? 0);
    a.impressions += impr;
    a.days += 1;
    if ((r.day as string) > a.lastDay) { a.lastDay = r.day as string; a.name = r.name ?? a.name; }
    const wt = (rate: unknown, addNum: (n: number) => void, addDen: (n: number) => void) => {
      if (rate == null) return;
      const n = Number(rate);
      if (!Number.isFinite(n)) return;
      addNum(n * impr); addDen(impr);
    };
    wt(r.impr_share, (n) => (a.isNum += n), (n) => (a.isDen += n));
    wt(r.lost_is_budget, (n) => (a.budNum += n), (n) => (a.budDen += n));
    wt(r.lost_is_rank, (n) => (a.rankNum += n), (n) => (a.rankDen += n));
    byId.set(id, a);
  }

  const rate = (num: number, den: number): number | null => (den > 0 ? num / den : null);
  const rows = [...byId.values()]
    .map((a) => ({
      campaignId: a.campaignId,
      name: a.name,
      spendCents: a.spendCents,
      clicks: a.clicks,
      impressions: a.impressions,
      ctr: a.impressions > 0 ? a.clicks / a.impressions : null,
      cpcCents: a.clicks > 0 ? Math.round(a.spendCents / a.clicks) : null,
      cpmCents: a.impressions > 0 ? Math.round((a.spendCents / a.impressions) * 1000) : null,
      imprShare: isGoogle ? rate(a.isNum, a.isDen) : null,
      lostIsBudget: isGoogle ? rate(a.budNum, a.budDen) : null,
      lostIsRank: isGoogle ? rate(a.rankNum, a.rankDen) : null,
    }))
    .filter((r) => r.spendCents > 0 || r.impressions > 0)
    .sort((a, b) => b.spendCents - a.spendCents);

  const totals = rows.reduce(
    (t, r) => {
      t.spendCents += r.spendCents; t.clicks += r.clicks; t.impressions += r.impressions;
      return t;
    },
    { spendCents: 0, clicks: 0, impressions: 0 }
  );

  return NextResponse.json({
    channel: isGoogle ? "google" : "meta",
    days,
    rows,
    totals: {
      ...totals,
      ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : null,
      cpcCents: totals.clicks > 0 ? Math.round(totals.spendCents / totals.clicks) : null,
      cpmCents: totals.impressions > 0 ? Math.round((totals.spendCents / totals.impressions) * 1000) : null,
    },
  });
}
