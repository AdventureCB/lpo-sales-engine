import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { shopifyAdminToken, shopifyAdminConfigured, SHOP_DOMAIN } from "@/lib/shopify-admin";
import { classifyOrder, orderCamperEligibility, zipCoords, zip5, type CamperVersion } from "@/lib/camper-owners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STATE_KEY = "camper_owners_sync";
const API_VERSION = "2026-01";
const PAGE = 50;
const DEADLINE_MS = 45_000;

const ORDERS_QUERY = `query($cursor: String, $q: String) {
  orders(first: ${PAGE}, after: $cursor, query: $q, sortKey: CREATED_AT) {
    edges { cursor node {
      name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
      customer { id firstName lastName email phone }
      billingAddress { city provinceCode zip }
      shippingAddress { city provinceCode zip }
      lineItems(first: 25) { edges { node { sku title quantity currentQuantity unfulfilledQuantity } } }
    } }
    pageInfo { hasNextPage endCursor }
  }
}`;

/**
 * Sync camper owners from Shopify. Default = resumable FULL scan (cursor in
 * crm_sync_state) classifying every order in code — so blank-SKU early V1
 * campers aren't missed. ?incremental=1 = only orders updated since the last
 * completed scan. ?reset=1 restarts the full scan.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!shopifyAdminConfigured()) return NextResponse.json({ error: "shopify not configured" }, { status: 200 });
  const db = supabaseAdmin();
  const url = new URL(req.url);
  const incremental = url.searchParams.get("incremental") === "1";
  const reset = url.searchParams.get("reset") === "1";

  const token = await shopifyAdminToken(db);
  const gql = async (variables: Record<string, unknown>) => {
    const r = await fetch(`https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: ORDERS_QUERY, variables }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || j?.errors) throw new Error(`shopify ${r.status}: ${JSON.stringify(j?.errors ?? j).slice(0, 200)}`);
    return j.data.orders;
  };

  const { data: st } = await db.from("crm_sync_state").select("value").eq("key", STATE_KEY).maybeSingle();
  const state = (reset ? {} : ((st?.value as any) ?? {})) as { cursor?: string; lastFullAt?: string; done?: boolean; scanToken?: string };

  const filter = incremental && state.lastFullAt ? `updated_at:>'${state.lastFullAt}'` : null;
  let cursor = incremental ? undefined : state.cursor;
  // Eligibility is OR'd across an owner's orders WITHIN one scan (token) and
  // recomputed from scratch on the next full scan.
  let scanToken = state.scanToken ?? state.lastFullAt ?? "init";
  if (!incremental && !cursor) {
    scanToken = new Date().toISOString();
    await mergeState(db, { scanToken, cursor: undefined, done: false });
  }

  const started = Date.now();
  let scanned = 0;
  let upserts = 0;
  let pages = 0;
  let hasNext = true;
  let endCursor: string | undefined;

  while (Date.now() - started < DEADLINE_MS) {
    const orders = await gql({ cursor: cursor ?? null, q: filter });
    pages++;
    for (const edge of orders.edges) {
      scanned++;
      const o = edge.node;
      const items = (o.lineItems?.edges ?? []).map((e: any) => e.node);
      const version = classifyOrder(items);
      if (!version) continue;
      if (await upsertOwner(db, o, version, items, scanToken, incremental)) upserts++;
    }
    hasNext = orders.pageInfo.hasNextPage;
    endCursor = orders.pageInfo.endCursor;
    cursor = endCursor;
    if (!hasNext) break;
  }

  if (incremental) {
    if (!hasNext) await mergeState(db, { lastFullAt: new Date().toISOString() });
  } else if (!hasNext) {
    await db.from("crm_sync_state").upsert(
      { key: STATE_KEY, value: { done: true, lastFullAt: new Date().toISOString(), scanToken }, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  } else {
    await mergeState(db, { cursor: endCursor, done: false });
  }

  return NextResponse.json({ ok: true, mode: incremental ? "incremental" : "full", scanned, upserts, pages, done: !hasNext });
}

async function mergeState(db: any, patch: Record<string, unknown>) {
  const { data } = await db.from("crm_sync_state").select("value").eq("key", STATE_KEY).maybeSingle();
  await db.from("crm_sync_state").upsert(
    { key: STATE_KEY, value: { ...((data?.value as any) ?? {}), ...patch }, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

async function upsertOwner(db: any, o: any, version: CamperVersion, items: any[], scanToken: string, incremental: boolean): Promise<boolean> {
  const cust = o.customer ?? {};
  const email = (cust.email ?? "").trim().toLowerCase() || null;
  const key = cust.id ? String(cust.id) : email;
  if (!key) return false;
  // Owner location = BILLING (customer's home); shipping is the installer.
  const addr = o.billingAddress ?? o.shippingAddress ?? {};
  const zip = zip5(addr.zip);
  const coords = zipCoords(zip);
  const name = [cust.firstName, cust.lastName].filter(Boolean).join(" ").trim() || email || "Unknown";
  const orderAt = o.createdAt;
  const elig = orderCamperEligibility(o, items);

  let contactId: string | null = null;
  if (email) {
    const { data: c } = await db
      .from("crm_contacts")
      .select("id")
      .filter("emails", "cs", JSON.stringify([{ value: email }]))
      .limit(1)
      .maybeSingle();
    contactId = c?.id ?? null;
  }

  const { data: existing } = await db
    .from("camper_owners")
    .select("id, version, camper_order_at, camper_order_name, address_manual, eligible, eligibility_reason, scan_token")
    .eq("owner_key", key)
    .maybeSingle();
  const mergedVersion =
    existing?.version === "both"
      ? "both"
      : existing && existing.version && existing.version !== version
        ? "both"
        : version;
  // Eligibility: within one scan an owner is eligible if ANY camper order
  // qualifies; a new scan starts fresh. Incremental runs only see changed
  // orders — if the order we recorded as their camper just went bad
  // (cancelled / refunded), that flips them off until the next full scan.
  const sameScan = existing?.scan_token === scanToken;
  let eligible: boolean;
  let reason: string | null;
  if (!existing || !sameScan) {
    eligible = elig.eligible;
    reason = elig.reason;
  } else if (incremental && !elig.eligible && existing.camper_order_name === o.name) {
    eligible = false;
    reason = elig.reason;
  } else {
    eligible = !!existing.eligible || elig.eligible;
    reason = eligible ? null : existing.eligibility_reason ?? elig.reason;
  }
  // The recorded camper order prefers a QUALIFYING order; among those, the newest.
  const existingQualifies = !!existing?.camper_order_at && !!existing?.eligible && sameScan;
  const keepThisOrder = elig.eligible
    ? !existingQualifies || Date.parse(orderAt) >= Date.parse(existing!.camper_order_at)
    : !existing?.camper_order_at || (!existingQualifies && Date.parse(orderAt) >= Date.parse(existing.camper_order_at));
  const keepAddress = keepThisOrder && !existing?.address_manual; // never clobber a manual fix

  const row: Record<string, unknown> = {
    owner_key: key,
    shopify_customer_id: cust.id ? String(cust.id) : null,
    name,
    email,
    phone: (cust.phone ?? "").trim() || null,
    version: mergedVersion,
    contact_id: contactId,
    eligible,
    eligibility_reason: reason,
    scan_token: scanToken,
    synced_at: new Date().toISOString(),
  };
  if (keepThisOrder) {
    Object.assign(row, {
      camper_order_name: o.name ?? null,
      camper_order_at: orderAt,
      order_line_items: items.map((it) => ({ sku: it.sku, title: it.title, qty: it.quantity })),
    });
  }
  if (keepAddress) {
    Object.assign(row, {
      city: addr.city ?? null,
      state: addr.provinceCode ?? null,
      zip,
      lat: coords?.[0] ?? null,
      lng: coords?.[1] ?? null,
    });
  }
  const { error } = await db.from("camper_owners").upsert(row, { onConflict: "owner_key" });
  return !error;
}
