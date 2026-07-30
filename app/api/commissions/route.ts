import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Commissions dashboard data: journeys with their orders and talk-time
 * (to-deposit / to-confirmation), plus per-rep rollups.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const db = supabaseAdmin();
  const [journeysRes, ordersRes, talkRes, repsRes] = await Promise.all([
    db
      .from("sales_journeys")
      .select("id, rep_id, code_rep_id, deal_owner_rep_id, state, is_conflict, deposit_started_at, confirmed_at, expires_at, eligible_total_cents, commission_amount_cents")
      .order("deposit_started_at", { ascending: false, nullsFirst: false })
      .limit(500),
    db
      .from("sales_orders")
      .select("journey_id, order_number, customer_email, customer_name_norm, classification, subtotal_cents, order_created_at")
      .not("journey_id", "is", null)
      .limit(2000),
    db.rpc("journey_talk_times"),
    db.from("reps").select("id, name"),
  ]);
  const firstError = journeysRes.error ?? ordersRes.error ?? talkRes.error ?? repsRes.error;
  if (firstError) {
    console.error("commissions query failed", firstError);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  const repName = new Map((repsRes.data ?? []).map((r) => [r.id, r.name]));
  const talk = new Map<string, { toDeposit: number; toConfirm: number }>(
    (talkRes.data ?? []).map((t: any) => [
      t.journey_id as string,
      { toDeposit: t.talk_to_deposit_s as number, toConfirm: t.talk_to_confirm_s as number },
    ])
  );
  const ordersByJourney = new Map<string, any[]>();
  for (const o of ordersRes.data ?? []) {
    ordersByJourney.set(o.journey_id, [...(ordersByJourney.get(o.journey_id) ?? []), o]);
  }

  const journeys = (journeysRes.data ?? []).map((j) => {
    const orders = (ordersByJourney.get(j.id) ?? []).sort((a, b) =>
      (a.order_created_at ?? "").localeCompare(b.order_created_at ?? "")
    );
    const first = orders[0];
    return {
      ...j,
      rep: j.rep_id ? repName.get(j.rep_id) ?? null : null,
      codeRep: j.code_rep_id ? repName.get(j.code_rep_id) ?? null : null,
      ownerRep: j.deal_owner_rep_id ? repName.get(j.deal_owner_rep_id) ?? null : null,
      customer: first?.customer_name_norm || first?.customer_email || "—",
      email: first?.customer_email ?? null,
      orders: orders.map((o) => ({
        number: o.order_number,
        classification: o.classification,
        subtotal_cents: o.subtotal_cents,
      })),
      talkToDepositS: talk.get(j.id)?.toDeposit ?? 0,
      talkToConfirmS: talk.get(j.id)?.toConfirm ?? 0,
    };
  });

  // Per-rep rollups: confirmed journeys, commission owed, avg talk times.
  const perRep = new Map<string, { rep: string; confirmed: number; commissionCents: number; depTalk: number[]; confTalk: number[] }>();
  for (const j of journeys) {
    if (!j.rep) continue;
    let agg = perRep.get(j.rep);
    if (!agg) perRep.set(j.rep, (agg = { rep: j.rep, confirmed: 0, commissionCents: 0, depTalk: [], confTalk: [] }));
    if (j.state === "confirmed" || j.state === "walk_in" || j.state === "paid") {
      agg.confirmed++;
      agg.commissionCents += j.commission_amount_cents;
      if (j.talkToConfirmS > 0) agg.confTalk.push(j.talkToConfirmS);
    }
    if (j.deposit_started_at && j.talkToDepositS > 0) agg.depTalk.push(j.talkToDepositS);
  }
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const summary = [...perRep.values()].map((a) => ({
    rep: a.rep,
    confirmed: a.confirmed,
    commissionCents: a.commissionCents,
    avgTalkToDepositS: avg(a.depTalk),
    avgTalkToConfirmS: avg(a.confTalk),
    depositSample: a.depTalk.length,
    confirmSample: a.confTalk.length,
  }));

  return NextResponse.json({ journeys, summary });
}
