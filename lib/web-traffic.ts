import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyAdminToken, SHOP_DOMAIN } from "./shopify-admin";

/**
 * Shopify sessions analytics (ShopifyQL through the Admin GraphQL
 * `shopifyqlQuery` field) → web_traffic_* cache tables. Requires the app to
 * have `read_reports` and protected-customer-data level 2; the error from
 * Shopify is surfaced verbatim so the admin page can say what is missing.
 */
const API_VERSION = "2026-01";

export async function shopifyql(db: SupabaseClient, q: string): Promise<{ columns: string[]; rows: string[][] }> {
  const token = await shopifyAdminToken(db);
  const r = await fetch(`https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `query($q: String!) { shopifyqlQuery(query: $q) { parseErrors tableData { rows columns { name } } } }`, variables: { q } }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.errors) throw new Error(`shopify ${r.status}: ${JSON.stringify(j?.errors ?? j).slice(0, 400)}`);
  const d = j?.data?.shopifyqlQuery;
  if (Array.isArray(d?.parseErrors) ? d.parseErrors.length : d?.parseErrors) throw new Error(`ShopifyQL: ${JSON.stringify(d.parseErrors).slice(0, 300)}`);
  const columns = (d?.tableData?.columns ?? []).map((c: any) => String(c.name));
  const rows = (d?.tableData?.rows ?? []) as string[][];
  return { columns, rows };
}

const n = (v: unknown) => Math.round(Number(v ?? 0)) || 0;
const pick = (columns: string[], row: string[]) => Object.fromEntries(columns.map((c, i) => [c, row[i]]));

export async function syncTrafficRange(db: SupabaseClient, start: string, end: string) {
  const now = new Date().toISOString();
  // Site totals per day
  const t = await shopifyql(db, `FROM sessions SHOW sessions, online_store_visitors, pageviews, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout TIMESERIES day SINCE ${start} UNTIL ${end}`);
  const daily = t.rows.map((r) => { const o = pick(t.columns, r); return { day: String(o.day).slice(0, 10), sessions: n(o.sessions), visitors: n(o.online_store_visitors), pageviews: n(o.pageviews), atc: n(o.sessions_with_cart_additions), reached_checkout: n(o.sessions_that_reached_checkout), completed_checkout: n(o.sessions_that_completed_checkout), synced_at: now }; });
  if (daily.length) { const { error } = await db.from("web_traffic_daily").upsert(daily, { onConflict: "day" }); if (error) throw new Error(error.message); }

  const s = await shopifyql(db, `FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_completed_checkout GROUP BY day, referrer_source, referrer_name SINCE ${start} UNTIL ${end} ORDER BY sessions DESC LIMIT 1000`);
  const sources = s.rows.map((r) => { const o = pick(s.columns, r); return { day: String(o.day).slice(0, 10), source: String(o.referrer_source ?? ""), name: String(o.referrer_name ?? ""), sessions: n(o.sessions), atc: n(o.sessions_with_cart_additions), completed_checkout: n(o.sessions_that_completed_checkout), synced_at: now }; });
  if (sources.length) { const { error } = await db.from("web_traffic_sources").upsert(sources, { onConflict: "day,source,name" }); if (error) throw new Error(error.message); }

  const d = await shopifyql(db, `FROM sessions SHOW sessions GROUP BY day, session_device_type SINCE ${start} UNTIL ${end} ORDER BY sessions DESC LIMIT 1000`);
  const devices = d.rows.map((r) => { const o = pick(d.columns, r); return { day: String(o.day).slice(0, 10), device: String(o.session_device_type ?? ""), sessions: n(o.sessions), synced_at: now }; });
  if (devices.length) { const { error } = await db.from("web_traffic_devices").upsert(devices, { onConflict: "day,device" }); if (error) throw new Error(error.message); }

  const p = await shopifyql(db, `FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_completed_checkout GROUP BY week, landing_page_path SINCE ${start} UNTIL ${end} ORDER BY sessions DESC LIMIT 1000`);
  const pages = p.rows.map((r) => { const o = pick(p.columns, r); return { week: String(o.week).slice(0, 10), path: String(o.landing_page_path ?? "") || "/", sessions: n(o.sessions), atc: n(o.sessions_with_cart_additions), completed_checkout: n(o.sessions_that_completed_checkout), synced_at: now }; });
  // A week straddling the range edge is partial here; nightly windows start on a Monday so whole weeks are re-summed.
  if (pages.length) { const { error } = await db.from("web_traffic_pages").upsert(pages, { onConflict: "week,path" }); if (error) throw new Error(error.message); }

  return { start, end, daily: daily.length, sources: sources.length, devices: devices.length, pages: pages.length };
}
