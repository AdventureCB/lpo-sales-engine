import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyShopifyHmac, moneyToCents } from "@/lib/shopify";
import { normalizeEmail, normalizeName, normalizePhone } from "@/lib/identity";

export const runtime = "nodejs";

/**
 * Shopify webhooks: orders/paid + orders/refunded.
 * Phase 0 scope: HMAC-verified delivery lands an idempotent row in
 * sales_orders. Journey classification/attribution (Phase 4) reads from here;
 * refunds re-store the full order payload so the journey engine can always
 * recompute from scratch.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifyShopifyHmac(rawBody, req.headers.get("x-shopify-hmac-sha256"))) {
    return NextResponse.json({ error: "invalid hmac" }, { status: 401 });
  }

  const topic = req.headers.get("x-shopify-topic") ?? "";
  if (topic !== "orders/paid" && topic !== "orders/refunded") {
    // Acknowledge unknown topics so Shopify doesn't retry them forever.
    return NextResponse.json({ ok: true, ignored: topic });
  }

  let order: any;
  try {
    order = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!order?.id) return NextResponse.json({ error: "no order id" }, { status: 400 });

  const db = supabaseAdmin();
  const row = {
    shopify_order_id: order.id,
    order_number: order.name ?? String(order.order_number ?? order.id),
    customer_email: normalizeEmail(order.email ?? order.customer?.email),
    customer_shopify_id: order.customer?.id ?? null,
    customer_name_norm: normalizeName(
      [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ")
    ),
    customer_phone: normalizePhone(order.phone ?? order.customer?.phone),
    // subtotal_price is already net of ALL discounts including order-level —
    // do NOT sum line_items[].discountedTotal (misses order-level discounts).
    subtotal_cents: moneyToCents(order.subtotal_price),
    discount_codes: order.discount_codes ?? [],
    order_created_at: order.created_at ?? null,
    raw: order,
  };

  if (topic === "orders/paid") {
    // Duplicate deliveries are routine → idempotent insert on shopify_order_id.
    const { error } = await db
      .from("sales_orders")
      .upsert(row, { onConflict: "shopify_order_id", ignoreDuplicates: true });
    if (error) {
      console.error("shopify orders/paid insert failed", error);
      return NextResponse.json({ error: "db error" }, { status: 500 });
    }
  } else {
    // orders/refunded ships the full order — refresh the stored payload so the
    // journey recompute (Phase 4) sees current refund state. Upsert covers
    // refunds arriving for orders that predate webhook installation.
    const { error } = await db
      .from("sales_orders")
      .upsert(row, { onConflict: "shopify_order_id", ignoreDuplicates: false });
    if (error) {
      console.error("shopify orders/refunded upsert failed", error);
      return NextResponse.json({ error: "db error" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
