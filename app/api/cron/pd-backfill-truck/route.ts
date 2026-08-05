import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CURSOR_KEY = "pd_truck_backfill_cursor";
const META_KEY = "pd_truck_field";
const TIME_BUDGET_MS = 40_000;

/**
 * Discover Pipedrive's truck-model custom deal field (key, type, option
 * labels) into crm_sync_state, then walk every deal stamping
 * crm_deals.truck_model. Cursor-resumable.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${env("CRON_SECRET")}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = supabaseAdmin();
  const started = Date.now();
  const token = env("PIPEDRIVE_API_TOKEN");

  // 1. Field discovery (once).
  let { data: metaRow } = await db.from("crm_sync_state").select("value").eq("key", META_KEY).maybeSingle();
  let meta: { key: string; type: string; options: Record<string, string> } | null =
    (metaRow?.value as any)?.key ? (metaRow!.value as any) : null;
  if (!meta) {
    let start = 0;
    let found: any = null;
    for (let page = 0; page < 5 && !found; page++) {
      const res = await fetch(
        `https://api.pipedrive.com/v1/dealFields?start=${start}&limit=100&api_token=${token}`
      );
      const json = await res.json();
      found = (json.data ?? []).find((f: any) => /truck|vehicle/i.test(f.name ?? ""));
      if (!json.additional_data?.pagination?.more_items_in_collection) break;
      start += 100;
    }
    if (!found) {
      return NextResponse.json({ error: "no deal field matching /truck|vehicle/i found" }, { status: 404 });
    }
    meta = {
      key: found.key,
      type: found.field_type,
      options: Object.fromEntries((found.options ?? []).map((o: any) => [String(o.id), o.label])),
    };
    await db.from("crm_sync_state").upsert(
      { key: META_KEY, value: { ...meta, name: found.name }, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  }

  const valueToLabel = (v: unknown): string | null => {
    if (v === null || v === undefined || v === "") return null;
    const s = String(v);
    // Enum/set fields carry option ids (possibly comma-separated).
    if (Object.keys(meta!.options).length > 0) {
      return s
        .split(",")
        .map((part) => meta!.options[part.trim()] ?? part.trim())
        .join(", ");
    }
    return s;
  };

  // 2. Walk deals.
  const { data: state } = await db.from("crm_sync_state").select("value").eq("key", CURSOR_KEY).maybeSingle();
  let cursor: string | null = (state?.value as any)?.cursor ?? null;
  let pages = 0;
  let stamped = 0;

  while (Date.now() - started < TIME_BUDGET_MS) {
    const u = new URL("https://api.pipedrive.com/api/v2/deals");
    u.searchParams.set("api_token", token);
    u.searchParams.set("limit", "500");
    u.searchParams.set("custom_fields", meta.key);
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await fetch(u);
    const json = await res.json().catch(() => ({}));
    if (res.status === 429) return NextResponse.json({ done: false, pages, stamped, halted: "rate limit" });
    if (!res.ok || json.success === false) {
      return NextResponse.json({ error: `Pipedrive deals ${res.status}`, pages, stamped }, { status: 502 });
    }
    for (const d of json.data ?? []) {
      const label = valueToLabel(d.custom_fields?.[meta.key]);
      if (!label) continue;
      const { count } = await db
        .from("crm_deals")
        .update({ truck_model: label }, { count: "exact" })
        .eq("pipedrive_deal_id", d.id);
      stamped += count ?? 0;
    }
    pages++;
    cursor = json.additional_data?.next_cursor ?? null;
    await db.from("crm_sync_state").upsert(
      { key: CURSOR_KEY, value: { cursor }, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    if (!cursor) {
      await db.from("crm_sync_state").delete().eq("key", CURSOR_KEY);
      return NextResponse.json({ done: true, pages, stamped, field: meta.key, type: meta.type });
    }
  }
  return NextResponse.json({ done: false, pages, stamped });
}
