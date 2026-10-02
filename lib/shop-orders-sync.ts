import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyAdminToken, SHOP_DOMAIN } from "./shopify-admin";

/**
 * Line-level mirror of Shopify orders for revenue analytics (shop_orders +
 * shop_order_lines) and the product ↔ collection map (shop_products +
 * shop_collections). Full history is a resumable CREATED_AT scan (cursor in
 * crm_sync_state); incremental runs pull orders updated since the last run.
 * Product ids on line items and the catalog need the read_products scope —
 * until the Admin app has it, lines resolve to products by SKU / title
 * against a catalog seeded by hand.
 */

export const STATE_KEY = "shop_orders_sync";
const API_VERSION = "2026-01";
const PAGE = 40;

export interface SyncState {
  cursor?: string;
  done?: boolean;
  lastFullAt?: string;
  lastIncrementalAt?: string;
  catalogAt?: string;
  catalogError?: string | null;
  ordersScanned?: number;
}

// product/variant on line items need read_products; asking for them without
// the scope floods the response with ACCESS_DENIED errors until Shopify
// truncates it, so they are only requested when the scope is granted.
const ordersQuery = (withProducts: boolean) => `query($cursor: String, $q: String, $sort: OrderSortKeys!) {
  orders(first: ${PAGE}, after: $cursor, query: $q, sortKey: $sort) {
    edges { cursor node {
      id name createdAt updatedAt cancelledAt test displayFinancialStatus
      sourceName app { name }
      customAttributes { key value }
      customer { id firstName lastName displayName email }
      billingAddress { name }
      subtotalPriceSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      discountCodes
      refunds { id createdAt refundLineItems(first: 60) { edges { node { quantity subtotalSet { shopMoney { amount } } lineItem { id } } } } }
      lineItems(first: 60) { edges { node {
        id sku title quantity
        ${withProducts ? "product { id } variant { id }" : ""}
        originalTotalSet { shopMoney { amount } }
        totalDiscountSet { shopMoney { amount } }
        discountAllocations {
          allocatedAmountSet { shopMoney { amount } }
          discountApplication { __typename
            ... on DiscountCodeApplication { code }
            ... on ManualDiscountApplication { title }
            ... on AutomaticDiscountApplication { title }
            ... on ScriptDiscountApplication { title } }
        }
      } } }
    } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const PRODUCTS_QUERY = `query($cursor: String) {
  products(first: 100, after: $cursor, sortKey: ID) {
    edges { node { id title handle status productType
      collections(first: 30) { edges { node { id } } }
      variants(first: 100) { edges { node { sku } } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const COLLECTIONS_QUERY = `{ collections(first: 250) { edges { node { id title handle productsCount { count } ruleSet { rules { column } } } } } }`;

function gid(id: unknown): number | null {
  if (!id) return null;
  const m = String(id).match(/\/(\d+)$/);
  return m ? Number(m[1]) : Number.isFinite(Number(id)) ? Number(id) : null;
}
const cents = (m: any): number => Math.round(Number(m?.shopMoney?.amount ?? m?.amount ?? 0) * 100) || 0;

export function normName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** GraphQL call that tolerates ACCESS_DENIED on optional fields (product/variant). */
async function gql(token: string, query: string, variables: Record<string, unknown>) {
  const r = await fetch(`https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`shopify ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const errors: any[] = j?.errors ?? [];
  const hard = errors.filter((e) => e?.extensions?.code !== "ACCESS_DENIED");
  if (hard.length) throw new Error(`shopify: ${JSON.stringify(hard).slice(0, 300)}`);
  if (!j?.data) throw new Error(`shopify: ${JSON.stringify(errors).slice(0, 300)}`);
  return { data: j.data, accessDenied: errors.length > 0 };
}

const SCOPES_QUERY = `{ currentAppInstallation { accessScopes { handle } } }`;

export async function hasProductsScope(token: string): Promise<boolean> {
  try {
    const { data } = await gql(token, SCOPES_QUERY, {});
    return (data.currentAppInstallation?.accessScopes ?? []).some((s: any) => s.handle === "read_products");
  } catch {
    return false;
  }
}

export async function readState(db: SupabaseClient): Promise<SyncState> {
  const { data } = await db.from("crm_sync_state").select("value").eq("key", STATE_KEY).maybeSingle();
  return ((data?.value as SyncState) ?? {}) as SyncState;
}

async function mergeState(db: SupabaseClient, patch: Partial<SyncState>) {
  const cur = await readState(db);
  await db.from("crm_sync_state").upsert(
    { key: STATE_KEY, value: { ...cur, ...patch }, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

function orderRow(o: any) {
  const cust = o.customer ?? {};
  const name =
    (cust.displayName ?? "").trim() ||
    [cust.firstName, cust.lastName].filter(Boolean).join(" ").trim() ||
    (o.billingAddress?.name ?? "").trim() ||
    null;
  const email = (cust.email ?? "").trim().toLowerCase() || null;
  return {
    id: gid(o.id),
    name: o.name ?? null,
    created_at: o.createdAt,
    updated_at: o.updatedAt ?? null,
    cancelled_at: o.cancelledAt ?? null,
    test: !!o.test,
    financial_status: o.displayFinancialStatus ?? null,
    source_name: o.sourceName ?? null,
    app_name: o.app?.name ?? null,
    // Shopify Collabs stamps referred orders with a __ref_id note attribute.
    collabs_ref: ((o.customAttributes ?? []).find((a: any) => a?.key === "__ref_id")?.value ?? "").toString().trim() || null,
    customer_id: gid(cust.id),
    customer_name: name,
    customer_name_norm: normName(name ?? email),
    customer_email: email,
    subtotal_cents: cents(o.subtotalPriceSet),
    discounts_cents: cents(o.totalDiscountsSet),
    shipping_cents: cents(o.totalShippingPriceSet),
    tax_cents: cents(o.totalTaxSet),
    total_cents: cents(o.totalPriceSet),
    refunded_cents: cents(o.totalRefundedSet),
    discount_codes: Array.isArray(o.discountCodes) ? o.discountCodes : [],
    synced_at: new Date().toISOString(),
  };
}

/** One row per (refund, line): dated so returns can book on the refund date. */
function refundRows(o: any, orderId: number) {
  const out: { refund_id: number; line_id: number; order_id: number; created_at: string; cents: number; qty: number }[] = [];
  for (const r of o.refunds ?? []) {
    const rid = gid(r.id);
    if (!rid || !r.createdAt) continue;
    const byLine = new Map<number, { cents: number; qty: number }>();
    for (const e of r.refundLineItems?.edges ?? []) {
      const n = e.node;
      const lid = gid(n.lineItem?.id);
      if (!lid) continue;
      const cur = byLine.get(lid) ?? { cents: 0, qty: 0 };
      cur.cents += cents(n.subtotalSet);
      cur.qty += Number(n.quantity ?? 0) || 0;
      byLine.set(lid, cur);
    }
    for (const [line_id, v] of byLine) out.push({ refund_id: rid, line_id, order_id: orderId, created_at: r.createdAt, ...v });
  }
  return out;
}

function lineRows(o: any, orderId: number) {
  const refunds = new Map<number, { cents: number; qty: number }>();
  for (const r of refundRows(o, orderId)) {
    const cur = refunds.get(r.line_id) ?? { cents: 0, qty: 0 };
    cur.cents += r.cents;
    cur.qty += r.qty;
    refunds.set(r.line_id, cur);
  }
  return (o.lineItems?.edges ?? []).map((e: any) => {
    const n = e.node;
    const id = gid(n.id)!;
    const allocs = (n.discountAllocations ?? []).map((a: any) => {
      const app = a.discountApplication ?? {};
      const label = (app.code ?? app.title ?? app.__typename?.replace(/DiscountApplication$/, "") ?? "Other").toString().trim() || "Other";
      return { label, cents: cents(a.allocatedAmountSet) };
    });
    const discount = allocs.length ? allocs.reduce((s: number, a: any) => s + a.cents, 0) : cents(n.totalDiscountSet);
    const ref = refunds.get(id) ?? { cents: 0, qty: 0 };
    return {
      id,
      order_id: orderId,
      product_id: gid(n.product?.id),
      variant_id: gid(n.variant?.id),
      sku: (n.sku ?? "").trim() || null,
      title: n.title ?? null,
      quantity: Number(n.quantity ?? 0) || 0,
      gross_cents: cents(n.originalTotalSet),
      discount_cents: discount,
      refund_cents: ref.cents,
      refund_qty: ref.qty,
      discounts: allocs,
    };
  });
}

async function upsertOrders(db: SupabaseClient, nodes: any[]) {
  const orders = nodes.map(orderRow).filter((r) => r.id);
  if (!orders.length) return 0;
  const lines = nodes.flatMap((o) => lineRows(o, gid(o.id)!));
  const { error } = await db.from("shop_orders").upsert(orders, { onConflict: "id" });
  if (error) throw new Error(`shop_orders upsert: ${error.message}`);
  const ids = orders.map((o) => o.id);
  const { error: delErr } = await db.from("shop_order_lines").delete().in("order_id", ids);
  if (delErr) throw new Error(`shop_order_lines delete: ${delErr.message}`);
  if (lines.length) {
    const { error: lineErr } = await db.from("shop_order_lines").upsert(lines, { onConflict: "id" });
    if (lineErr) throw new Error(`shop_order_lines upsert: ${lineErr.message}`);
  }
  const refunds = nodes.flatMap((o) => refundRows(o, gid(o.id)!));
  const { error: rdel } = await db.from("shop_order_refunds").delete().in("order_id", ids);
  if (rdel) throw new Error(`shop_order_refunds delete: ${rdel.message}`);
  if (refunds.length) {
    const { error: rerr } = await db.from("shop_order_refunds").upsert(refunds, { onConflict: "refund_id,line_id" });
    if (rerr) throw new Error(`shop_order_refunds upsert: ${rerr.message}`);
  }
  return orders.length;
}

/**
 * Orders sync. full: resumable scan of ALL orders oldest→newest (cursor kept
 * across runs until done). incremental: orders updated since the last
 * incremental run (1h overlap), newest updates first.
 */
export async function syncShopOrders(
  db: SupabaseClient,
  opts: { mode: "full" | "incremental"; deadlineMs?: number; reset?: boolean }
) {
  const token = await shopifyAdminToken(db);
  const started = Date.now();
  const deadline = opts.deadlineMs ?? 45_000;
  const state = opts.reset ? {} : await readState(db);
  const runStartedAt = new Date().toISOString();

  let cursor: string | undefined;
  let q: string | null = null;
  let sort = "CREATED_AT";
  if (opts.mode === "incremental") {
    const since = state.lastIncrementalAt ?? state.lastFullAt;
    const from = since ? new Date(Date.parse(since) - 60 * 60_000) : new Date(Date.now() - 24 * 60 * 60_000);
    q = `updated_at:>='${from.toISOString()}'`;
    sort = "UPDATED_AT";
  } else {
    cursor = state.cursor;
    if (state.done && !opts.reset) return { mode: "full", done: true, scanned: 0, pages: 0, skipped: "already complete" };
  }

  const withProducts = await hasProductsScope(token);
  const query = ordersQuery(withProducts);
  let scanned = 0;
  let pages = 0;
  let hasNext = true;
  let endCursor: string | undefined;
  let accessDenied = !withProducts;
  while (Date.now() - started < deadline) {
    const { data, accessDenied: ad } = await gql(token, query, { cursor: cursor ?? null, q, sort });
    accessDenied = accessDenied || ad;
    const conn = data.orders;
    pages++;
    const nodes = conn.edges.map((e: any) => e.node);
    scanned += await upsertOrders(db, nodes);
    hasNext = conn.pageInfo.hasNextPage;
    endCursor = conn.pageInfo.endCursor;
    cursor = endCursor;
    if (opts.mode === "full") await mergeState(db, { cursor: endCursor, done: false, ordersScanned: (state.ordersScanned ?? 0) + scanned });
    if (!hasNext) break;
  }

  if (opts.mode === "incremental") {
    if (!hasNext) await mergeState(db, { lastIncrementalAt: runStartedAt });
  } else if (!hasNext) {
    await mergeState(db, { cursor: undefined, done: true, lastFullAt: runStartedAt, lastIncrementalAt: runStartedAt });
  }
  if (scanned) {
    await db.rpc("shop_resolve_lines");
    await db.rpc("shop_refresh_order_flags"); // test-checkout / rep-code / staff-built / net per order
  }
  return { mode: opts.mode, done: !hasNext, scanned, pages, productFieldsDenied: accessDenied };
}

/** Products + collections from the Admin API. Needs read_products. */
export async function syncShopCatalog(db: SupabaseClient) {
  const token = await shopifyAdminToken(db);
  try {
    const col = await gql(token, COLLECTIONS_QUERY, {});
    if (col.accessDenied || !col.data.collections) throw new Error("read_products scope missing");
    const collections = col.data.collections.edges.map((e: any) => ({
      id: gid(e.node.id),
      title: e.node.title,
      handle: e.node.handle ?? null,
      products_count: e.node.productsCount?.count ?? null,
      rule_based: !!(e.node.ruleSet?.rules?.length),
      synced_at: new Date().toISOString(),
    }));
    if (collections.length) await db.from("shop_collections").upsert(collections, { onConflict: "id" });

    let cursor: string | null = null;
    let products = 0;
    for (let i = 0; i < 40; i++) {
      const { data, accessDenied } = await gql(token, PRODUCTS_QUERY, { cursor });
      if (accessDenied || !data.products) throw new Error("read_products scope missing");
      const rows = data.products.edges.map((e: any) => {
        const n = e.node;
        return {
          id: gid(n.id),
          title: n.title,
          handle: n.handle ?? null,
          status: n.status ?? null,
          product_type: n.productType ?? "",
          skus: Array.from(new Set((n.variants?.edges ?? []).map((v: any) => (v.node.sku ?? "").trim()).filter(Boolean))),
          collection_ids: (n.collections?.edges ?? []).map((c: any) => gid(c.node.id)).filter(Boolean),
          synced_at: new Date().toISOString(),
        };
      });
      if (rows.length) {
        const { error } = await db.from("shop_products").upsert(rows, { onConflict: "id" });
        if (error) throw new Error(`shop_products upsert: ${error.message}`);
      }
      products += rows.length;
      if (!data.products.pageInfo.hasNextPage) break;
      cursor = data.products.pageInfo.endCursor;
    }
    await db.rpc("shop_resolve_lines");
    await mergeState(db, { catalogAt: new Date().toISOString(), catalogError: null });
    return { ok: true, collections: collections.length, products };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await mergeState(db, { catalogError: msg });
    return { ok: false, error: msg };
  }
}
