import "server-only";
import crypto from "node:crypto";
import { env } from "./env";

/**
 * Shopify webhook HMAC verification: SHA-256 over the RAW request body with
 * the webhook secret, base64, constant-time compare vs X-Shopify-Hmac-Sha256.
 */
export function verifyShopifyHmac(rawBody: string, hmacHeader: string | null): boolean {
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac("sha256", env("SHOPIFY_WEBHOOK_SECRET"))
    .update(rawBody, "utf8")
    .digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** "500.00" → 50000. Shopify sends money as decimal strings. */
export function moneyToCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}
