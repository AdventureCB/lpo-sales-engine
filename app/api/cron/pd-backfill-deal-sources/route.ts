import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CURSOR_KEY = "pd_deal_source_backfill_cursor";
const TIME_BUDGET_MS = 40_000;

/**
 * One-time source mapping: seed deal_sources with Pipedrive's channel
 * labels (dealFields), then walk every deal and stamp source_id from its
 * channel. Cursor-resumable; call until done=true.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${env("CRON_SECRET")}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = supabaseAdmin();
  const started = Date.now();
  const token = env("PIPEDRIVE_API_TOKEN");

  // 1. Channel labels → deal_sources (insert-only; admin renames win).
  const { data: seeded } = await db.from("crm_sync_state").select("value").eq("key", "pd_channel_labels_seeded").maybeSingle();
  if (!seeded) {
    let start = 0;
    let channelOptions: { id: number; label: string }[] = [];
    for (let page = 0; page < 5; page++) {
      const res = await fetch(
        `https://api.pipedrive.com/v1/dealFields?start=${start}&limit=100&api_token=${token}`
      );
      const json = await res.json();
      const field = (json.data ?? []).find((f: any) => f.key === "channel");
      if (field) {
        channelOptions = (field.options ?? []).map((o: any) => ({ id: Number(o.id), label: o.label }));
        break;
      }
      if (!json.additional_data?.pagination?.more_items_in_collection) break;
      start += 100;
    }
    for (const o of channelOptions) {
      await db.from("deal_sources").upsert(
        { pipedrive_channel_id: o.id, name: o.label },
        { onConflict: "pipedrive_channel_id", ignoreDuplicates: true }
      );
    }
    await db.from("crm_sync_state").upsert(
      { key: "pd_channel_labels_seeded", value: { count: channelOptions.length, at: new Date().toISOString() } },
      { onConflict: "key" }
    );
  }

  // Map channel → source uuid once.
  const { data: sources } = await db.from("deal_sources").select("id, pipedrive_channel_id");
  const srcByChannel = new Map(
    (sources ?? []).filter((s) => s.pipedrive_channel_id != null).map((s) => [s.pipedrive_channel_id, s.id])
  );

  // 2. Walk deals, stamp source_id.
  const { data: state } = await db.from("crm_sync_state").select("value").eq("key", CURSOR_KEY).maybeSingle();
  let cursor: string | null = (state?.value as any)?.cursor ?? null;
  let pages = 0;
  let stamped = 0;

  while (Date.now() - started < TIME_BUDGET_MS) {
    const u = new URL("https://api.pipedrive.com/api/v2/deals");
    u.searchParams.set("api_token", token);
    u.searchParams.set("limit", "500");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await fetch(u);
    const json = await res.json().catch(() => ({}));
    if (res.status === 429) return NextResponse.json({ done: false, pages, stamped, halted: "rate limit" });
    if (!res.ok || json.success === false) {
      return NextResponse.json({ error: `Pipedrive deals ${res.status}`, pages, stamped }, { status: 502 });
    }
    const deals = json.data ?? [];
    // Group by channel, one UPDATE per channel per page.
    const byChannel = new Map<number, number[]>();
    for (const d of deals) {
      if (typeof d.channel !== "number") continue;
      if (!srcByChannel.has(d.channel)) continue;
      const list = byChannel.get(d.channel) ?? [];
      list.push(d.id);
      byChannel.set(d.channel, list);
    }
    for (const [channel, ids] of byChannel) {
      for (let i = 0; i < ids.length; i += 200) {
        const { count } = await db
          .from("crm_deals")
          .update({ source_id: srcByChannel.get(channel)! }, { count: "exact" })
          .in("pipedrive_deal_id", ids.slice(i, i + 200));
        stamped += count ?? 0;
      }
    }
    pages++;
    cursor = json.additional_data?.next_cursor ?? null;
    await db.from("crm_sync_state").upsert(
      { key: CURSOR_KEY, value: { cursor }, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    if (!cursor) {
      await db.from("crm_sync_state").delete().eq("key", CURSOR_KEY);
      return NextResponse.json({ done: true, pages, stamped });
    }
  }
  return NextResponse.json({ done: false, pages, stamped });
}
