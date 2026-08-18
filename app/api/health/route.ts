import { NextResponse } from "next/server";

export const runtime = "nodejs";

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "SHOPIFY_WEBHOOK_SECRET",
  "SHOPIFY_ADMIN_TOKEN",
  "SHOPIFY_STORE_DOMAIN",
  "QUO_API_KEY",
  "QUO_WEBHOOK_SECRET",
  "PIPEDRIVE_API_TOKEN",
  "KLAVIYO_PRIVATE_KEY",
  "CRON_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "KLAVIYO_OAUTH_CLIENT_ID",
  "KLAVIYO_OAUTH_CLIENT_SECRET",
  "TELNYX_API_KEY",
  "DEEPGRAM_API_KEY",
] as const;

/** Deploy check: reports which env vars are present (booleans only, never values).
 * Exception: the OAuth client id IS public (it appears in every consent URL),
 * so expose enough of it to debug mismatches. */
export async function GET() {
  const envStatus = Object.fromEntries(REQUIRED_ENV.map((k) => [k, Boolean(process.env[k])]));
  const cid = process.env.GOOGLE_CLIENT_ID ?? "";
  const kid = process.env.KLAVIYO_OAUTH_CLIENT_ID ?? "";
  return NextResponse.json({
    ok: true,
    version: {
      sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      message: (process.env.VERCEL_GIT_COMMIT_MESSAGE ?? "").split("\n")[0] || null,
      // Deploy id changes per deployment; created-at isn't exposed, so the
      // stamp shows the commit as the meaningful identity.
      deployedAt: null,
    },
    env: envStatus,
    googleClientIdPrefix: cid.slice(0, 20),
    googleClientIdLength: cid.length,
    klaviyoClientIdPrefix: kid.slice(0, 8),
    klaviyoClientIdLength: kid.length,
  });
}
