import "server-only";
import crypto from "node:crypto";
import { env } from "./env";

/**
 * Quo webhook signature (OpenPhone-heritage scheme). Header value:
 *   hmac;<version>;<timestamp>;<base64 digest>
 * digest = HMAC-SHA256(base64decode(secret), `${timestamp}.${rawBody}`).
 * Checks `quo-signature` and the legacy `openphone-signature` header.
 *
 * Each Quo webhook (calls / transcripts / messages) has its own signing key,
 * so QUO_WEBHOOK_SECRET holds them comma-separated; any match passes.
 */
export function verifyQuoSignature(rawBody: string, headers: Headers): boolean {
  const header = headers.get("quo-signature") ?? headers.get("openphone-signature");
  if (!header) return false;
  const parts = header.split(";");
  if (parts.length !== 4 || parts[0] !== "hmac") return false;
  const [, , timestamp, providedDigest] = parts;
  const b = Buffer.from(providedDigest);
  return env("QUO_WEBHOOK_SECRET")
    .split(",")
    .some((secret) => {
      const digest = crypto
        .createHmac("sha256", Buffer.from(secret.trim(), "base64"))
        .update(`${timestamp}.${rawBody}`, "utf8")
        .digest("base64");
      const a = Buffer.from(digest);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
}
