import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { shopifyAdminConfigured } from "@/lib/shopify-admin";
import { syncShopOrders, syncShopCatalog } from "@/lib/shop-orders-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Shopify order mirror for revenue analytics.
 *   default      → resumable FULL history scan (cursor kept until done)
 *   ?incremental=1 → orders updated since the last run (hourly cron)
 *   ?catalog=1   → products + collections (needs read_products)
 *   ?reset=1     → restart the full scan from the beginning
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!shopifyAdminConfigured()) return NextResponse.json({ error: "shopify not configured" }, { status: 200 });
  const db = supabaseAdmin();
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("catalog") === "1") {
      return NextResponse.json(await syncShopCatalog(db));
    }
    const incremental = url.searchParams.get("incremental") === "1";
    const res = await syncShopOrders(db, {
      mode: incremental ? "incremental" : "full",
      reset: url.searchParams.get("reset") === "1",
      deadlineMs: 48_000,
    });
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
