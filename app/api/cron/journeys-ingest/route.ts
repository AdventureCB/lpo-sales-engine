import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { moneyToCents } from "@/lib/shopify";
import { normalizeEmail, normalizeName, normalizePhone } from "@/lib/identity";
import { recomputeJourneysForEmail } from "@/lib/journeys";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Backfill ingestion: accepts orders already normalized to the webhook's REST
 * shape (id, name, email, phone, customer, subtotal_price, discount_codes,
 * tags, created_at, line_items[{product_id,title,price,quantity,
 * total_discount}], refunds). Cron-secret auth — used by the operator-driven
 * historical backfill, not by Shopify.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { orders?: any[]; emails?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const orders = body.orders ?? [];
  const db = supabaseAdmin();
  const emails = new Set<string>((body.emails ?? []).map((e) => e.toLowerCase()));
  if (orders.length === 0 && emails.size === 0) {
    return NextResponse.json({ ok: true, ingested: 0 });
  }
  let ingested = 0;
  for (const order of orders) {
    if (!order?.id) continue;
    const email = normalizeEmail(order.email ?? order.customer?.email);
    const row = {
      shopify_order_id: order.id,
      order_number: order.name ?? String(order.id),
      customer_email: email,
      customer_shopify_id: order.customer?.id ?? null,
      customer_name_norm: normalizeName(
        [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ")
      ),
      customer_phone: normalizePhone(order.phone ?? order.customer?.phone),
      subtotal_cents: moneyToCents(order.subtotal_price),
      discount_codes: order.discount_codes ?? [],
      order_created_at: order.created_at ?? null,
      raw: order,
    };
    const { error } = await db
      .from("sales_orders")
      .upsert(row, { onConflict: "shopify_order_id", ignoreDuplicates: false });
    if (error) return NextResponse.json({ error: error.message, ingested }, { status: 500 });
    ingested++;
    if (email) emails.add(email);
  }

  let recomputed = 0;
  for (const email of emails) {
    await recomputeJourneysForEmail(db, email);
    recomputed++;
  }
  return NextResponse.json({ ok: true, ingested, recomputed });
}
