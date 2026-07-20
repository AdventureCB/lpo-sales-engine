import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let client: SupabaseClient | null = null;

/**
 * Service-role client for server-side routes (webhooks, cron). Never expose
 * to the browser; the desktop companion authenticates via Supabase Auth and
 * talks only to our API routes.
 */
export function supabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
