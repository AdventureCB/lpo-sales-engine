import "server-only";
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env, envOptional } from "./env";

/**
 * Klaviyo OAuth (account-level, admin connects once) — required for the
 * Conversations API (private keys are not accepted there). PKCE S256.
 */

const AUTHORIZE_URL = "https://www.klaviyo.com/oauth/authorize";
const TOKEN_URL = "https://a.klaviyo.com/oauth/token";
const API = "https://a.klaviyo.com/api";
const REVISION = "2025-04-15";

export const KLAVIYO_SCOPES =
  "conversations:read conversations:write profiles:read events:read metrics:read";

export function klaviyoOauthConfigured(): boolean {
  return Boolean(envOptional("KLAVIYO_OAUTH_CLIENT_ID") && envOptional("KLAVIYO_OAUTH_CLIENT_SECRET"));
}

export function redirectUri(): string {
  const base = envOptional("APP_URL") ?? "https://lpo-sales-engine.vercel.app";
  return `${base}/api/klaviyo/callback`;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authUrl(state: string, challenge: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", env("KLAVIYO_OAUTH_CLIENT_ID"));
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("scope", KLAVIYO_SCOPES);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("code_challenge", challenge);
  return u.toString();
}

function basicAuth(): string {
  return Buffer.from(`${env("KLAVIYO_OAUTH_CLIENT_ID")}:${env("KLAVIYO_OAUTH_CLIENT_SECRET")}`).toString("base64");
}

async function tokenRequest(params: Record<string, string>): Promise<any> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth()}`,
    },
    body: new URLSearchParams(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`klaviyo token ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

export async function exchangeCode(code: string, verifier: string) {
  const tok = await tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri(),
  });
  return {
    accessToken: tok.access_token as string,
    refreshToken: tok.refresh_token as string,
    expiresAt: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    scopes: tok.scope ?? KLAVIYO_SCOPES,
  };
}

/** Current access token for the account connection, refreshing as needed. */
export async function klaviyoAccessToken(db: SupabaseClient): Promise<string | null> {
  const { data: row } = await db.from("klaviyo_oauth").select("*").eq("id", 1).maybeSingle();
  if (!row || row.status === "disconnected") return null;
  if (row.access_token && row.token_expires_at && Date.parse(row.token_expires_at) > Date.now() + 60_000) {
    return row.access_token;
  }
  const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: row.refresh_token });
  const update: Record<string, unknown> = {
    access_token: tok.access_token,
    token_expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    status: "active",
    last_error: null,
  };
  if (tok.refresh_token) update.refresh_token = tok.refresh_token;
  await db.from("klaviyo_oauth").update(update).eq("id", 1);
  return tok.access_token as string;
}

/** JSON:API fetch with the OAuth token. */
export async function kOauthFetch(
  token: string,
  path: string,
  init?: RequestInit
): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      revision: REVISION,
      accept: "application/vnd.api+json",
      ...(init?.body ? { "Content-Type": "application/vnd.api+json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`klaviyo ${path} ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
  }
  return json;
}
