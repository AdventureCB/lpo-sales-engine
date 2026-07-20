import "server-only";
import crypto from "node:crypto";
import { env } from "./env";

/**
 * Quo webhook signature (OpenPhone-heritage scheme). Header value:
 *   hmac;<version>;<timestamp>;<base64 digest>
 * digest = HMAC-SHA256(base64decode(secret), `${timestamp}.${rawBody}`).
 * Checks `quo-signature` and the legacy `openphone-signature` header.
 */
export function verifyQuoSignature(rawBody: string, headers: Headers): boolean {
  const header = headers.get("quo-signature") ?? headers.get("openphone-signature");
  if (!header) return false;
  const parts = header.split(";");
  if (parts.length !== 4 || parts[0] !== "hmac") return false;
  const [, , timestamp, providedDigest] = parts;
  const key = Buffer.from(env("QUO_WEBHOOK_SECRET"), "base64");
  const digest = crypto
    .createHmac("sha256", key)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(providedDigest);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
