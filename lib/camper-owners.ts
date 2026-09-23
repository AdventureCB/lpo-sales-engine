import "server-only";
import zips from "./zip-centroids.json";

/**
 * Camper-owner identification + geo helpers for the Demo Finder.
 *
 * Ownership is determined from ACTUAL camper-unit line items only (Kyle 9/15):
 *   V1 = the "Campers" collection product (SKU LPCW, or the blank-SKU early
 *        camper whose line title is exactly "Lone Peak Camper")
 *   V2 = the "V2 Camper" collection (SKU prefix LPCV2-, the OLD LPC… set, or a
 *        line titled exactly "Lone Peak Camper V2")
 * Accessories, the deposit-only line, and the Weekender/Adventurer/Overlander
 * TRIM collections are NOT ownership signals (their SKUs are shared
 * accessories — see the collection audit). Shopify's fuzzy sku: search is only
 * a candidate narrower; every order is re-checked here exactly.
 */

// Explicit "Lone Peak Camper V2 (OLD)" SKUs (pre-LPCV2 naming).
const V2_OLD_SKUS = new Set([
  "LPCAAB", "LPCCAB", "LPCACB", "LPCCBB", "LPCABA", "LPCCBA", "LPCABB", "LPCCCB",
  "LPCBCB", "LPCBDB", "LPCCDB", "LPCAAA", "LPCCAA", "LPCCCC",
]);

export type CamperVersion = "v1" | "v2";

export interface OrderLineItem {
  sku: string | null;
  title: string | null;
  quantity?: number;
}

/** V1 / V2 / null for one order's line items — camper units only. */
/** Which camper (if any) ONE line item is. */
export function camperLineVersion(it: OrderLineItem): CamperVersion | null {
  const sku = (it.sku ?? "").trim().toUpperCase();
  const title = (it.title ?? "").trim().toLowerCase();
  // V2 = current LPCV2-* SKUs, the OLD "LPC"+3-letter fitment SKUs (regex
  // covers variants beyond the explicit set; no accessory uses this shape),
  // or an exact "Lone Peak Camper V2" title.
  if (sku.startsWith("LPCV2-") || /^LPC[A-D]{3}$/.test(sku) || V2_OLD_SKUS.has(sku) || title === "lone peak camper v2") return "v2";
  if (sku === "LPCW" || title === "lone peak camper") return "v1";
  return null;
}

export function classifyOrder(items: OrderLineItem[]): CamperVersion | null {
  let v1 = false;
  for (const it of items) {
    const v = camperLineVersion(it);
    if (v === "v2") return "v2"; // V2 wins if somehow both appear
    if (v === "v1") v1 = true;
  }
  return v1 ? "v1" : null;
}

/**
 * Does this order prove the customer HAS a camper (Kyle 9/23)? Only when the
 * order isn't cancelled/refunded and every camper line still on the order is
 * fulfilled. An unfulfilled order = build in progress; a cancelled deposit =
 * never happened. Accessories on the same order don't matter.
 */
export function orderCamperEligibility(
  order: { cancelledAt?: string | null; displayFinancialStatus?: string | null },
  items: (OrderLineItem & { currentQuantity?: number | null; unfulfilledQuantity?: number | null; quantity?: number | null })[]
): { eligible: boolean; reason: string | null } {
  if (order.cancelledAt) return { eligible: false, reason: "order cancelled" };
  const fin = String(order.displayFinancialStatus ?? "").toUpperCase();
  if (fin === "REFUNDED" || fin === "VOIDED") return { eligible: false, reason: `order ${fin.toLowerCase()}` };
  const campers = items.filter((it) => camperLineVersion(it));
  if (campers.length === 0) return { eligible: false, reason: "no camper on order" };
  // currentQuantity = quantity after removals/refunds; null on old API shapes → assume intact.
  const live = campers.filter((it) => (it.currentQuantity ?? it.quantity ?? 1) > 0);
  if (live.length === 0) return { eligible: false, reason: "camper removed / refunded" };
  if (live.some((it) => (it.unfulfilledQuantity ?? 0) > 0)) return { eligible: false, reason: "camper not fulfilled yet" };
  return { eligible: true, reason: null };
}

/** Camper SKUs to seed Shopify's `orders(query: "sku:…")` candidate narrowing.
 * (Not exhaustive by design — code-side classifyOrder is the source of truth;
 * blank-SKU V1 campers are caught by the periodic full scan.) */
export const CAMPER_SKU_HINTS = ["LPCW", "LPCV2-*", ...V2_OLD_SKUS];

// ── Geo ─────────────────────────────────────────────────────────────────────
const ZIPS = zips as unknown as Record<string, [number, number]>;

export function zip5(raw: string | null | undefined): string | null {
  const m = String(raw ?? "").match(/\d{5}/);
  return m ? m[0] : null;
}

export function zipCoords(raw: string | null | undefined): [number, number] | null {
  const z = zip5(raw);
  return z ? ZIPS[z] ?? null : null;
}

/** Great-circle miles between two lat/lng points. */
export function milesBetween(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
