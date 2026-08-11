import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { envOptional } from "./env";

/**
 * Shopify Admin API auth for the post-2026 Dev Dashboard app model: tokens
 * come from the client-credentials grant and expire every 24h, so we exchange
 * SHOPIFY_CLIENT_ID/SECRET on demand and cache in crm_sync_state. A legacy
 * static SHOPIFY_ADMIN_TOKEN (pre-2026 custom app) is honored when present.
 */

export const SHOP_DOMAIN = "lone-peak-overland.myshopify.com";
const STATE_KEY = "shopify_admin_oauth";

export function shopifyAdminConfigured(): boolean {
  return Boolean(envOptional("SHOPIFY_ADMIN_TOKEN") || (envOptional("SHOPIFY_CLIENT_ID") && envOptional("SHOPIFY_CLIENT_SECRET")));
}

export async function shopifyAdminToken(db: SupabaseClient): Promise<string> {
  const legacy = envOptional("SHOPIFY_ADMIN_TOKEN");
  if (legacy) return legacy;

  const clientId = envOptional("SHOPIFY_CLIENT_ID");
  const clientSecret = envOptional("SHOPIFY_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Shopify admin credentials not configured");

  const { data } = await db.from("crm_sync_state").select("value").eq("key", STATE_KEY).maybeSingle();
  const cached = data?.value as { access_token?: string; expires_at?: string } | null;
  if (cached?.access_token && cached.expires_at && Date.parse(cached.expires_at) > Date.now() + 5 * 60_000) {
    return cached.access_token;
  }

  const r = await fetch(`https://${SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
  });
  const tok = await r.json().catch(() => null);
  if (!r.ok || !tok?.access_token) {
    throw new Error(`shopify client-credentials grant failed: ${r.status} ${JSON.stringify(tok).slice(0, 150)}`);
  }
  await db.from("crm_sync_state").upsert(
    {
      key: STATE_KEY,
      value: {
        access_token: tok.access_token,
        expires_at: new Date(Date.now() + (tok.expires_in ?? 86_399) * 1000).toISOString(),
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );
  return tok.access_token as string;
}
