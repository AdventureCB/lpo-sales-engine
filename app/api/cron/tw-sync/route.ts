import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { twDailySpend, twOrdersWithJourneys, type TwOrderJourney } from "@/lib/triplewhale";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Daily Triple Whale sync:
 *  1. Channel spend per day → ad_spend (re-pulls a few trailing days since
 *     platforms restate spend).
 *  2. Per-order pixel journeys → tw_order_attribution, then stamped onto the
 *     contact (crm_contacts.attribution.tw) via sales_orders email match.
 * ?spendDays=N (default 3) · ?journeyDays=N (default 3) · one-off backfills
 * via larger values.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const spendDays = Math.min(Number(params.get("spendDays") ?? 3) || 3, 120);
  const journeyDays = Math.min(Number(params.get("journeyDays") ?? 3) || 3, 120);
  const db = supabaseAdmin();

  // ── 1. Spend ──
  const laDay = (offset: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.now() - offset * 86_400_000));
  let spendRows = 0;
  const spendErrors: string[] = [];
  for (let i = 0; i < spendDays; i++) {
    const day = laDay(i);
    try {
      const spends = await twDailySpend(day);
      for (const s of spends) {
        await db.from("ad_spend").upsert(
          { day, channel: s.channel, spend_cents: s.spendCents, updated_at: new Date().toISOString() },
          { onConflict: "day,channel" }
        );
        spendRows++;
      }
    } catch (e) {
      spendErrors.push(`${day}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }

  // ── 2. Journeys ──
  const endIso = new Date().toISOString();
  const startIso = new Date(Date.now() - journeyDays * 86_400_000).toISOString();
  let orders = 0, stamped = 0;
  const journeyErrors: string[] = [];
  try {
    for (let page = 1; page <= 50; page++) {
      const { orders: batch } = await twOrdersWithJourneys(startIso, endIso, page);
      if (batch.length === 0) break;
      for (const o of batch) {
        try {
          const s = await storeOrder(db, o);
          orders++;
          if (s) stamped++;
        } catch (e) {
          journeyErrors.push(`${o.order_id}: ${e instanceof Error ? e.message : "failed"}`);
        }
      }
      if (batch.length < 100) break;
    }
  } catch (e) {
    journeyErrors.push(e instanceof Error ? e.message : "journeys failed");
  }

  return NextResponse.json({
    ok: true, spendDays, spendRows, orders, contactsStamped: stamped,
    ...(spendErrors.length ? { spendErrors: spendErrors.slice(0, 5) } : {}),
    ...(journeyErrors.length ? { journeyErrors: journeyErrors.slice(0, 5) } : {}),
  });
}

/** Pick the first meaningful click (skip TW's "Excluded"/"$0 order" filler). */
function pickClick(list: any[] | undefined): any | null {
  for (const c of list ?? []) {
    if (c && c.source && c.source !== "Excluded") return c;
  }
  return null;
}

async function storeOrder(db: ReturnType<typeof supabaseAdmin>, o: TwOrderJourney): Promise<boolean> {
  const orderId = Number(o.order_id);
  if (!Number.isFinite(orderId)) return false;
  const attr = o.attribution ?? {};
  const firstClick = pickClick(attr.fullFirstClick) ?? pickClick(attr.firstClick);
  const lastClick = pickClick(attr.fullLastClick) ?? pickClick(attr.lastClick) ?? pickClick(attr.lastPlatformClick);
  const journey = o.journey ?? [];
  const times = journey.map((j) => j.time).filter(Boolean) as string[];

  await db.from("tw_order_attribution").upsert(
    {
      shopify_order_id: orderId,
      order_name: o.order_name ?? null,
      customer_shopify_id: o.customer_id ?? null,
      order_created_at: o.created_at ? new Date(o.created_at).toISOString() : null,
      total_price_cents: Math.round(Number(o.total_price ?? 0) * 100),
      first_click: firstClick,
      last_click: lastClick,
      journey_events: journey.length,
      journey_first_at: times.length ? new Date(times.reduce((a, b) => (a < b ? a : b))).toISOString() : null,
      journey_last_at: times.length ? new Date(times.reduce((a, b) => (a > b ? a : b))).toISOString() : null,
      attribution_raw: attr,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "shopify_order_id" }
  );

  // Stamp the contact: TW journey → sales_orders email → crm_contacts.attribution.tw
  if (!firstClick && !lastClick) return false;
  const { data: so } = await db
    .from("sales_orders")
    .select("customer_email")
    .eq("shopify_order_id", orderId)
    .maybeSingle();
  const email = so?.customer_email?.toLowerCase();
  if (!email) return false;
  const { data: contact } = await db
    .from("crm_contacts")
    .select("id, attribution")
    .filter("emails", "cs", JSON.stringify([{ value: email }]))
    .limit(1)
    .maybeSingle();
  if (!contact) return false;

  const cur = (contact.attribution ?? {}) as Record<string, any>;
  const tw = {
    source: (lastClick ?? firstClick)?.source ?? null,
    campaign_id: (lastClick ?? firstClick)?.campaignId ?? null,
    first_source: firstClick?.source ?? null,
    first_campaign_id: firstClick?.campaignId ?? null,
    click_at: (lastClick ?? firstClick)?.clickDate ?? null,
    order_id: orderId,
  };
  // Keep the earliest order's TW attribution as canonical unless absent —
  // lead cost is about what ACQUIRED the deal, not the latest reorder.
  if (cur.tw && cur.tw.order_id && cur.tw.order_id <= orderId) return false;
  await db
    .from("crm_contacts")
    .update({ attribution: { ...cur, tw, updated_at: new Date().toISOString() } })
    .eq("id", contact.id);
  return true;
}
