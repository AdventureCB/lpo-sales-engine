import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { attributeDeals, campaignRevenue } from "@/lib/campaign-roas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Operator probe for first-party ad attribution (cron-secret auth, so it can
 * be hit from a shell): what the resolver attributes for a window.
 *   ?days=N  ?channel=google|facebook
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const days = Math.min(Math.max(Number(p.get("days") ?? 30) || 30, 1), 365);
  const channel = p.get("channel") ?? "google";
  const laDay = (offset: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() - offset * 86_400_000));
  const start = laDay(days - 1);
  const end = laDay(0);
  const startIso = `${start}T00:00:00Z`;
  const endIso = `${end}T23:59:59.999Z`;
  const db = supabaseAdmin();
  const t0 = Date.now();
  try {
    const attributed = await attributeDeals(db, startIso, endIso);
    const rev = await campaignRevenue(db, startIso, endIso);
    return NextResponse.json({
      start, end, ms: Date.now() - t0,
      createdDeals: attributed.created.length,
      wonDeals: attributed.won.length,
      wonNoContact: attributed.won.filter((d) => !d.contact).length,
      wonNoAttr: attributed.won.filter((d) => !d.attr).length,
      byCampaign: [...rev.entries()].filter(([k]) => k.startsWith(`${channel}|`)).map(([k, v]) => ({ key: k, ...v })),
      wonForChannel: attributed.won
        .filter((d) => d.attr?.channel === channel)
        .map((d) => ({ id: d.id, wonAt: d.at, valueCents: d.valueCents, campaignId: d.attr?.campaignId, source: d.attr?.source })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e), ms: Date.now() - t0 }, { status: 500 });
  }
}
