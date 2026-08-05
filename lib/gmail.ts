import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env, envOptional } from "./env";
import { normalizeEmail } from "./identity";

/**
 * Per-rep Gmail integration (read-only): OAuth connect + a periodic sweep
 * that lands each rep's sent/received mail on the matching contact's
 * timeline as `email` activities. Dedupe via crm_activities.pd_key
 * ("gmail:<mailbox>:<messageId>").
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
// readonly powers the timeline sweep; send is granted up front so reps only
// consent once — unused until the compose feature ships.
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

export const REDIRECT_PATH = "/api/gmail/callback";

/** Canonical redirect URI — must byte-match the one registered in Google
 * Cloud, regardless of which host (deployment URL, preview) served the app. */
export function redirectUri(): string {
  const base = envOptional("APP_URL") ?? "https://lpo-sales-engine.vercel.app";
  return `${base}${REDIRECT_PATH}`;
}

export function gmailConfigured(): boolean {
  return Boolean(envOptional("GOOGLE_CLIENT_ID") && envOptional("GOOGLE_CLIENT_SECRET"));
}

export function authUrl(redirectUri: string, state: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", env("GOOGLE_CLIENT_ID"));
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent"); // always issue a refresh token
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(
  code: string,
  redirectUri: string
): Promise<{ refreshToken: string; accessToken: string; expiresAt: string; googleEmail: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tok = await res.json();
  if (!res.ok || !tok.refresh_token) {
    throw new Error(`token exchange failed: ${JSON.stringify(tok).slice(0, 200)}`);
  }
  const profile = await fetch(`${API}/profile`, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  }).then((r) => r.json());
  return {
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    expiresAt: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    googleEmail: normalizeEmail(profile.emailAddress) ?? profile.emailAddress,
  };
}

async function freshAccessToken(db: SupabaseClient, account: any): Promise<string> {
  if (account.access_token && account.token_expires_at && Date.parse(account.token_expires_at) > Date.now() + 60_000) {
    return account.access_token;
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: account.refresh_token,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  const tok = await res.json();
  if (!res.ok) throw new Error(`token refresh failed: ${JSON.stringify(tok).slice(0, 200)}`);
  const expiresAt = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString();
  await db
    .from("gmail_accounts")
    .update({ access_token: tok.access_token, token_expires_at: expiresAt })
    .eq("user_email", account.user_email);
  return tok.access_token;
}

/** Send a plain-text email from the rep's connected Gmail. Returns the
 * Gmail message id (used to pre-dedupe against the timeline sweep). */
export async function sendGmail(
  db: SupabaseClient,
  account: any,
  opts: { to: string; subject: string; body: string }
): Promise<string> {
  const token = await freshAccessToken(db, account);
  const mime = [
    `From: ${account.google_email}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    opts.body,
  ].join("\r\n");
  const raw = Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch(`${API}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gmail send ${res.status}: ${JSON.stringify(json.error ?? {}).slice(0, 200)}`);
  return json.id as string;
}

function header(headers: any[], name: string): string | null {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function addressesIn(value: string | null): string[] {
  if (!value) return [];
  return [...value.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)].map((m) => m[0].toLowerCase());
}

/** Sweep one account's recent mail into contact timelines. */
export async function sweepGmailAccount(
  db: SupabaseClient,
  account: any,
  budgetMs: number
): Promise<{ scanned: number; matched: number }> {
  const started = Date.now();
  const token = await freshAccessToken(db, account);
  const sinceDays = account.last_synced_at
    ? Math.max(1, Math.ceil((Date.now() - Date.parse(account.last_synced_at)) / 86400_000) + 1)
    : 30; // first sync: last 30 days
  const q = `newer_than:${sinceDays}d -in:chats -in:spam -in:trash`;

  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(`${API}/messages`);
    u.searchParams.set("q", q);
    u.searchParams.set("maxResults", "100");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const page = await fetch(u, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    ids.push(...((page.messages ?? []).map((m: any) => m.id)));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < 1000 && Date.now() - started < budgetMs);

  // Skip messages already imported.
  const keys = ids.map((id) => `gmail:${account.google_email}:${id}`);
  const seen = new Set<string>();
  for (let i = 0; i < keys.length; i += 200) {
    const { data } = await db
      .from("crm_activities")
      .select("pd_key")
      .in("pd_key", keys.slice(i, i + 200));
    for (const r of data ?? []) seen.add(r.pd_key);
  }

  let matched = 0;
  const own = account.google_email.toLowerCase();
  for (const id of ids) {
    if (Date.now() - started >= budgetMs) break;
    const key = `gmail:${account.google_email}:${id}`;
    if (seen.has(key)) continue;
    const msg = await fetch(
      `${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then((r) => r.json());
    const headers = msg.payload?.headers ?? [];
    const from = addressesIn(header(headers, "From"));
    const toCc = [...addressesIn(header(headers, "To")), ...addressesIn(header(headers, "Cc"))];
    const inbound = !from.includes(own);
    const counterparts = (inbound ? from : toCc).filter((e) => e !== own);
    if (counterparts.length === 0) continue;

    // Match any counterpart to a CRM contact.
    let contactId: string | null = null;
    let matchedEmail: string | null = null;
    for (const email of counterparts) {
      const { data: contact } = await db
        .from("crm_contacts")
        .select("id")
        .contains("emails", JSON.stringify([{ value: email }]))
        .maybeSingle();
      if (contact) {
        contactId = contact.id;
        matchedEmail = email;
        break;
      }
    }
    if (!contactId) continue;

    const occurredAt = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date().toISOString();
    const { error } = await db.from("crm_activities").upsert(
      {
        pd_key: key,
        contact_id: contactId,
        type: "email",
        subject: `${inbound ? "📥" : "📤"} ${header(headers, "Subject") || "(no subject)"}`,
        body: msg.snippet ?? null,
        actor: inbound ? matchedEmail : account.user_email,
        occurred_at: occurredAt,
        meta: { gmail: true, direction: inbound ? "inbound" : "outbound" },
      },
      { onConflict: "pd_key", ignoreDuplicates: true }
    );
    if (!error) matched++;
  }

  await db
    .from("gmail_accounts")
    .update({ last_synced_at: new Date().toISOString(), status: "active", last_error: null })
    .eq("user_email", account.user_email);
  return { scanned: ids.length, matched };
}
