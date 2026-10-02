import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { syncTrafficRange } from "@/lib/web-traffic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STATE_KEY = "web_traffic_sync";

/**
 * Shopify sessions → web_traffic_* tables.
 *   default      → trailing 21 days, starting on a Monday (whole weeks for pages)
 *   ?start=YYYY-MM-DD&end=YYYY-MM-DD → one explicit window (≤ 31 days)
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  let start = p.get("start"), end = p.get("end");
  if (!start || !end) {
    const e = new Date(); e.setUTCDate(e.getUTCDate() - 1);
    const s = new Date(e); s.setUTCDate(s.getUTCDate() - 20);
    s.setUTCDate(s.getUTCDate() - ((s.getUTCDay() + 6) % 7)); // back to Monday
    start = day(s); end = day(e);
  }
  try {
    const res = await syncTrafficRange(db, start, end);
    await db.from("crm_sync_state").upsert({ key: STATE_KEY, value: { at: new Date().toISOString(), ok: true, ...res }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await db.from("crm_sync_state").upsert({ key: STATE_KEY, value: { at: new Date().toISOString(), ok: false, error: msg }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
