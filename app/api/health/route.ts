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
] as const;

/** Deploy check: reports which env vars are present (booleans only, never values). */
export async function GET() {
  const envStatus = Object.fromEntries(REQUIRED_ENV.map((k) => [k, Boolean(process.env[k])]));
  return NextResponse.json({ ok: true, env: envStatus });
}
