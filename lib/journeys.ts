import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { moneyToCents } from "./shopify";
import { normalizeEmail } from "./identity";

/**
 * Journey/commission engine (Phase 4 spec): deposit (~$500) opens a journey,
 * cumulative eligible subtotal ≥ $5k within 180 days confirms it ($100 flat),
 * walk-ins (≥ $5k, no open journey) confirm immediately. Refunds recompute
 * the whole customer from scratch — everything here is recompute-from-scratch
 * by construction, keyed on customer email.
 */

const DEPOSIT_MIN_CENTS = 49_900; // ≈$500 ±$1
const DEPOSIT_MAX_CENTS = 50_100;
const CONFIRM_THRESHOLD_CENTS = 500_000; // $5k cumulative eligible
const WINDOW_DAYS = 180;
const FOLLOW_ON_DAYS = 30; // orders this soon after a confirmation attach to it
const COMMISSION_CENTS = 10_000; // $100 flat, earned at confirmation

const MERCH_TITLE_RE = /hoodie|t-shirt|tee\b|sweatshirt|beanie|\bhat\b|sticker|merch/i;
const DEPOSIT_TITLE_RE = /deposit/i;

interface OrderRow {
  id: string;
  shopify_order_id: number;
  customer_email: string | null;
  customer_phone: string | null;
  subtotal_cents: number | null;
  discount_codes: any[];
  order_created_at: string | null;
  journey_id: string | null;
  raw: any;
}

interface RepRef {
  id: string;
  first: string;
}

async function loadReps(db: SupabaseClient): Promise<RepRef[]> {
  const { data } = await db.from("reps").select("id, name").eq("active", true);
  return (data ?? []).map((r) => ({ id: r.id, first: r.name.split(" ")[0].toUpperCase() }));
}

async function loadProductTypes(db: SupabaseClient, productIds: number[]): Promise<Map<number, string>> {
  if (productIds.length === 0) return new Map();
  const { data } = await db
    .from("shopify_products")
    .select("product_id, product_type")
    .in("product_id", productIds);
  return new Map((data ?? []).map((p) => [p.product_id, p.product_type]));
}

function lineItems(raw: any): any[] {
  return Array.isArray(raw?.line_items) ? raw.line_items : [];
}

/** Post-discount value of a REST line item, minus refunded quantity value. */
function lineValueCents(li: any): number {
  const gross = (moneyToCents(li.price) ?? 0) * (li.quantity ?? 1);
  const discount = moneyToCents(li.total_discount) ?? 0;
  return Math.max(0, gross - discount);
}

/**
 * Eligible subtotal: order subtotal (already net of all discounts) minus the
 * post-discount value of excluded lines (Merch), minus refunds.
 */
function computeEligibleCents(order: OrderRow, productTypes: Map<number, string>): number {
  let eligible = order.subtotal_cents ?? 0;
  for (const li of lineItems(order.raw)) {
    const type = li.product_id ? productTypes.get(Number(li.product_id)) : undefined;
    const isMerch = type === "Merch" || (!type && MERCH_TITLE_RE.test(li.title ?? ""));
    if (isMerch) eligible -= lineValueCents(li);
  }
  for (const refund of order.raw?.refunds ?? []) {
    for (const rli of refund.refund_line_items ?? []) {
      eligible -= moneyToCents(rli.subtotal) ?? 0;
    }
  }
  return Math.max(0, eligible);
}

function isDepositOrder(order: OrderRow, productTypes: Map<number, string>, eligible: number): boolean {
  const hasDepositLine = lineItems(order.raw).some(
    (li) =>
      (li.product_id && productTypes.get(Number(li.product_id)) === "Deposit") ||
      DEPOSIT_TITLE_RE.test(li.title ?? "")
  );
  if (hasDepositLine) return true;
  return eligible >= DEPOSIT_MIN_CENTS && eligible <= DEPOSIT_MAX_CENTS && lineItems(order.raw).length <= 1;
}

/** Rep from order tags ("PARKER") or discount codes — registry first, then first-name prefix. */
function attributeCodeRep(
  order: OrderRow,
  reps: RepRef[],
  codeRegistry: Map<string, string>
): string | null {
  const candidates: string[] = [];
  const tags = order.raw?.tags;
  if (typeof tags === "string") candidates.push(...tags.split(",").map((t: string) => t.trim()));
  else if (Array.isArray(tags)) candidates.push(...tags);
  for (const dc of order.discount_codes ?? []) {
    const code = typeof dc === "string" ? dc : dc?.code;
    if (code) candidates.push(code);
  }
  for (const c of candidates) {
    const upper = c.toUpperCase().trim();
    const registered = codeRegistry.get(upper);
    if (registered) return registered;
    const prefixed = reps.find((r) => upper.startsWith(r.first));
    if (prefixed) return prefixed.id;
  }
  return null;
}

/** Cross-check: CRM mirror deal owner for this customer email. */
async function dealOwnerRep(db: SupabaseClient, email: string, reps: RepRef[]): Promise<string | null> {
  const { data: contact } = await db
    .from("crm_contacts")
    .select("id")
    .contains("emails", JSON.stringify([{ value: email }]))
    .maybeSingle();
  if (!contact) return null;
  const { data: deals } = await db
    .from("crm_deals")
    .select("owner_pipedrive_id, status, updated_at")
    .eq("contact_id", contact.id)
    .order("updated_at", { ascending: false })
    .limit(5);
  const ownerPd = (deals ?? []).find((d) => d.owner_pipedrive_id)?.owner_pipedrive_id;
  if (!ownerPd) return null;
  const { data: rep } = await db
    .from("reps")
    .select("id")
    .eq("pipedrive_user_id", ownerPd)
    .maybeSingle();
  return rep?.id ?? null;
}

/**
 * Recompute every journey for one customer from their orders, oldest first.
 * Deletes and rebuilds the customer's non-manual journeys — idempotent, and
 * refund handling falls out for free (eligible is derived from current raw).
 */
export async function recomputeJourneysForEmail(db: SupabaseClient, emailRaw: string): Promise<void> {
  const email = normalizeEmail(emailRaw);
  if (!email) return;

  const { data: orderRows } = await db
    .from("sales_orders")
    .select("id, shopify_order_id, customer_email, customer_phone, subtotal_cents, discount_codes, order_created_at, journey_id, raw")
    .eq("customer_email", email)
    .order("order_created_at", { ascending: true });
  const orders = (orderRows ?? []) as OrderRow[];
  if (orders.length === 0) return;

  const productIds = [
    ...new Set(orders.flatMap((o) => lineItems(o.raw).map((li) => Number(li.product_id)).filter(Boolean))),
  ];
  const [reps, productTypes, codesRes] = await Promise.all([
    loadReps(db),
    loadProductTypes(db, productIds),
    db.from("rep_codes").select("code, rep_id").eq("active", true),
  ]);
  const codeRegistry = new Map((codesRes.data ?? []).map((c) => [c.code.toUpperCase(), c.rep_id]));

  // Wipe this customer's machine-built journeys; orders re-link below.
  const orderIds = orders.map((o) => o.id);
  const staleIds = [...new Set(orders.map((o) => o.journey_id).filter(Boolean))] as string[];
  await db.from("sales_orders").update({ journey_id: null, classification: null }).in("id", orderIds);
  if (staleIds.length > 0) {
    await db.from("sales_journeys").delete().in("id", staleIds).neq("state", "paid");
  }

  // Walk oldest-first, building journeys in memory; insert at the end.
  interface Pending {
    state: "deposit_only" | "confirmed" | "walk_in" | "expired";
    depositAt: string | null;
    confirmedAt: string | null;
    cumulative: number;
    orderIds: string[];
    codeRep: string | null;
  }
  const journeys: Pending[] = [];
  const classify = (orderId: string, c: string) =>
    db.from("sales_orders").update({ classification: c }).eq("id", orderId);

  let open: Pending | null = null;
  let lastClosed: Pending | null = null; // most recent confirmed/walk_in

  for (const order of orders) {
    const at = order.order_created_at ?? new Date().toISOString();
    const eligible = computeEligibleCents(order, productTypes);
    const codeRep = attributeCodeRep(order, reps, codeRegistry);

    // Close an open journey whose window lapsed before this order.
    if (open && Date.parse(at) > Date.parse(open.depositAt!) + WINDOW_DAYS * 86400_000) {
      open.state = "expired";
      journeys.push(open);
      open = null;
    }

    if (!open && isDepositOrder(order, productTypes, eligible)) {
      await classify(order.id, "deposit");
      open = { state: "deposit_only", depositAt: at, confirmedAt: null, cumulative: eligible, orderIds: [order.id], codeRep };
      continue;
    }

    if (eligible <= 0) {
      await classify(order.id, "other");
      continue;
    }

    if (open) {
      open.cumulative += eligible;
      open.orderIds.push(order.id);
      open.codeRep = open.codeRep ?? codeRep;
      if (open.cumulative >= CONFIRM_THRESHOLD_CENTS) {
        await classify(order.id, "confirmation");
        open.state = "confirmed";
        open.confirmedAt = at;
        journeys.push(open);
        lastClosed = open;
        open = null;
      } else {
        await classify(order.id, "other");
      }
    } else if (
      lastClosed?.confirmedAt &&
      Date.parse(at) - Date.parse(lastClosed.confirmedAt) <= FOLLOW_ON_DAYS * 86400_000
    ) {
      // Follow-on order shortly after a confirmed purchase (split checkout,
      // add-ons) — attach to that journey; one purchase, one commission.
      await classify(order.id, "other");
      lastClosed.cumulative += eligible;
      lastClosed.orderIds.push(order.id);
    } else if (eligible >= CONFIRM_THRESHOLD_CENTS) {
      await classify(order.id, "walk_in");
      const j: Pending = { state: "walk_in", depositAt: null, confirmedAt: at, cumulative: eligible, orderIds: [order.id], codeRep };
      journeys.push(j);
      lastClosed = j;
    } else {
      await classify(order.id, "other");
    }
  }

  if (open) {
    open.state =
      Date.now() > Date.parse(open.depositAt!) + WINDOW_DAYS * 86400_000 ? "expired" : "deposit_only";
    journeys.push(open);
  }

  const ownerRep = await dealOwnerRep(db, email, reps);
  for (const j of journeys) {
    const isConflict = Boolean(j.codeRep && ownerRep && j.codeRep !== ownerRep);
    const repId = j.codeRep ?? ownerRep;
    const commission = j.state === "confirmed" || j.state === "walk_in" ? COMMISSION_CENTS : 0;
    const { data: journey, error } = await db
      .from("sales_journeys")
      .insert({
        rep_id: isConflict ? null : repId,
        code_rep_id: j.codeRep,
        deal_owner_rep_id: ownerRep,
        state: j.state,
        is_conflict: isConflict,
        deposit_started_at: j.depositAt,
        confirmed_at: j.confirmedAt,
        expires_at:
          j.state === "deposit_only" || j.state === "expired"
            ? new Date(Date.parse(j.depositAt!) + WINDOW_DAYS * 86400_000).toISOString()
            : null,
        eligible_total_cents: j.cumulative,
        commission_amount_cents: isConflict ? 0 : commission,
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) throw new Error(`journey insert: ${error.message}`);
    await db.from("sales_orders").update({ journey_id: journey.id }).in("id", j.orderIds);
  }
}
