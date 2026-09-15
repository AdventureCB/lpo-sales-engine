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
export function classifyOrder(items: OrderLineItem[]): CamperVersion | null {
  let v1 = false;
  for (const it of items) {
    const sku = (it.sku ?? "").trim().toUpperCase();
    const title = (it.title ?? "").trim().toLowerCase();
    if (sku.startsWith("LPCV2-") || V2_OLD_SKUS.has(sku) || title === "lone peak camper v2") {
      return "v2"; // V2 wins if somehow both appear
    }
    if (sku === "LPCW" || title === "lone peak camper") v1 = true;
  }
  return v1 ? "v1" : null;
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
