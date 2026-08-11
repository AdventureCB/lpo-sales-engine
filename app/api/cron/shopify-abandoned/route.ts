import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { envOptional } from "@/lib/env";
import { shopifyAdminConfigured, shopifyAdminToken } from "@/lib/shopify-admin";
import { processIntake, type IntakeSource } from "@/lib/intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SHOP = "lone-peak-overland.myshopify.com";

/**
 * Abandoned-checkout poller (the native "New Abandoned Cart" Zapier trigger —
 * Shopify has no webhook for abandonment, so Zapier polls too). Every 15 min:
 * pull recent abandoned checkouts, apply each enabled engine's SKU filter and
 * settle-delay, and hand matches to the Intake Engine. Idempotent by
 * checkout id, so re-polling the same window is free.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();

  const { data: sources } = await db
    .from("intake_sources")
    .select("id, channel_id, label, adapter, enabled, config")
    .eq("adapter", "shopify_abandoned_checkout")
    .eq("enabled", true);
  if (!sources || sources.length === 0) return NextResponse.json({ ok: true, enabled: 0 });

  if (!shopifyAdminConfigured()) {
    return NextResponse.json({ error: "Shopify admin credentials not configured (SHOPIFY_CLIENT_ID/SECRET or legacy SHOPIFY_ADMIN_TOKEN)" }, { status: 200 });
  }
  const token = await shopifyAdminToken(db);
  const version = envOptional("SHOPIFY_API_VERSION") ?? "2026-01";
  const createdMin = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const r = await fetch(
    `https://${SHOP}/admin/api/${version}/checkouts.json?limit=250&created_at_min=${encodeURIComponent(createdMin)}`,
    { headers: { "X-Shopify-Access-Token": token } }
  );
  if (!r.ok) {
    const text = await r.text();
    return NextResponse.json({ error: `shopify ${r.status}: ${text.slice(0, 200)}` }, { status: 502 });
  }
  const { checkouts } = await r.json();

  const now = Date.now();
  const results: Record<string, number> = {};
  for (const src of sources as IntakeSource[]) {
    const cfg = src.config ?? {};
    const skuNeedle = (cfg.sku_contains ?? "").toLowerCase();
    const delayMs = (cfg.delay_minutes ?? 60) * 60_000;

    for (const co of checkouts ?? []) {
      if (co.completed_at) continue; // recovered — not abandoned
      const updated = Date.parse(co.updated_at ?? co.created_at ?? "");
      if (!Number.isFinite(updated) || now - updated < delayMs) continue; // still settling
      if (skuNeedle) {
        const hit = (co.line_items ?? []).some((li: any) => (li.sku ?? "").toLowerCase().includes(skuNeedle));
        if (!hit) continue;
      }
      const email = co.email ?? co.customer?.email ?? null;
      const phone = co.phone ?? co.shipping_address?.phone ?? co.billing_address?.phone ?? co.customer?.phone ?? null;
      if (!email && !phone) continue;
      const name =
        [co.customer?.first_name, co.customer?.last_name].filter(Boolean).join(" ") ||
        co.shipping_address?.name || co.billing_address?.name || null;

      const res = await processIntake(db, src, {
        externalId: String(co.id),
        email,
        phone,
        name,
        valueCents: co.total_price != null ? Math.round(Number(co.total_price) * 100) : null,
        link: co.abandoned_checkout_url ?? null,
        occurredAt: co.updated_at ?? co.created_at ?? null,
        meta: { checkout_token: co.token, source_channel_id: src.channel_id },
      });
      results[res.action] = (results[res.action] ?? 0) + 1;
    }
  }
  return NextResponse.json({ ok: true, engines: sources.length, checkouts: (checkouts ?? []).length, results });
}
