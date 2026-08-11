import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { getLists, getRecentListMembers } from "@/lib/klaviyo";
import { processIntake, type IntakeSource } from "@/lib/intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Klaviyo-list intake watcher (e.g. Synchrony financing applicants): every
 * 15 min, pull each enabled klaviyo_list engine's newest list members and
 * feed NEW joins (since the per-source cursor) to the Intake Engine. The
 * cursor starts at first-run time — existing list members are not
 * backfilled, matching the Zap's "new subscriber" semantics.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();

  const { data: sources } = await db
    .from("intake_sources")
    .select("id, channel_id, label, adapter, enabled, config")
    .eq("adapter", "klaviyo_list")
    .eq("enabled", true);
  if (!sources || sources.length === 0) return NextResponse.json({ ok: true, enabled: 0 });

  const summary: Record<string, unknown> = {};
  for (const src of sources as (IntakeSource & { config: { klaviyo_list_id?: string; klaviyo_list_name?: string } })[]) {
    try {
      // Resolve the list id from its name once; cache back onto the config.
      let listId = src.config.klaviyo_list_id;
      if (!listId && src.config.klaviyo_list_name) {
        const lists = await getLists();
        listId = lists.find((l) => l.name.toLowerCase() === src.config.klaviyo_list_name!.toLowerCase())?.id;
        if (listId) {
          await db
            .from("intake_sources")
            .update({ config: { ...src.config, klaviyo_list_id: listId }, updated_at: new Date().toISOString() })
            .eq("id", src.id);
        }
      }
      if (!listId) {
        summary[src.label] = "list not found";
        continue;
      }

      const cursorKey = `intake:klaviyo_list:${src.id}`;
      const { data: cur } = await db.from("crm_sync_state").select("value").eq("key", cursorKey).maybeSingle();
      let cursor = (cur?.value as any)?.last_joined_at as string | undefined;
      if (!cursor) {
        // First run: start from now — new joins only, no historical backfill.
        cursor = new Date().toISOString();
        await db.from("crm_sync_state").upsert(
          { key: cursorKey, value: { last_joined_at: cursor }, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
        summary[src.label] = "cursor initialized";
        continue;
      }

      const members = await getRecentListMembers(listId, 50);
      const fresh = members.filter((m) => m.joinedAt && m.joinedAt > cursor!);
      const counts: Record<string, number> = {};
      let maxJoined = cursor;
      // Oldest-first so the round-robin order matches join order.
      for (const m of fresh.reverse()) {
        const props = m.properties ?? {};
        const noteBits = ["notes_summary", "notes", "Notes Summary"]
          .map((k) => props[k])
          .filter((v) => typeof v === "string" && (v as string).trim());
        const res = await processIntake(db, src, {
          externalId: m.profileId,
          email: m.email,
          phone: m.phone,
          name: [m.firstName, m.lastName].filter(Boolean).join(" ") || null,
          note: (noteBits[0] as string) ?? null,
          meta: {
            klaviyo_list_id: listId,
            joined_at: m.joinedAt,
            source_channel: props.source_channel ?? props.source ?? null,
            source_id: props.source_id ?? null,
          },
        });
        counts[res.action] = (counts[res.action] ?? 0) + 1;
        if (m.joinedAt && m.joinedAt > maxJoined) maxJoined = m.joinedAt;
      }
      if (maxJoined > cursor) {
        await db.from("crm_sync_state").upsert(
          { key: cursorKey, value: { last_joined_at: maxJoined }, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
      }
      summary[src.label] = { newMembers: fresh.length, ...counts };
    } catch (e) {
      summary[src.label] = `error: ${e instanceof Error ? e.message : "failed"}`;
    }
  }
  return NextResponse.json({ ok: true, engines: sources.length, summary });
}
