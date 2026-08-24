import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { getLists, getSegments, getRecentListMembers, getRecentSegmentMembers } from "@/lib/klaviyo";
import { runKlaviyoMetricEngines } from "@/lib/klaviyo-metric-engines";
import { processIntake, type IntakeSource } from "@/lib/intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Klaviyo intake watcher: every 15 min, feed the Intake Engine from
 *  - klaviyo_list engines (e.g. Synchrony applicants): NEW list joins
 *  - klaviyo_metric engines (e.g. Saved Build): NEW metric events, with
 *    subscriber enrichment (name/phone from the profile — Zap parity)
 * Cursors start at first-run time — no historical backfill.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();

  const { data: sources } = await db
    .from("intake_sources")
    .select("id, channel_id, label, adapter, enabled, config")
    .in("adapter", ["klaviyo_list", "klaviyo_segment", "klaviyo_metric"])
    .eq("enabled", true);
  if (!sources || sources.length === 0) return NextResponse.json({ ok: true, enabled: 0 });

  const summary: Record<string, unknown> = {};

  // ── Metric-event engines (shared runner — the hot-list cron also calls it) ──
  Object.assign(summary, await runKlaviyoMetricEngines(db));

  // ── Group-membership engines (lists + segments share semantics) ──
  for (const src of (sources as (IntakeSource & {
    config: { klaviyo_list_id?: string; klaviyo_list_name?: string; klaviyo_segment_id?: string; klaviyo_segment_name?: string };
  })[]).filter((s) => s.adapter === "klaviyo_list" || s.adapter === "klaviyo_segment")) {
    try {
      const isSegment = src.adapter === "klaviyo_segment";
      // Resolve the group id from its name once; cache back onto the config.
      let listId = isSegment ? src.config.klaviyo_segment_id : src.config.klaviyo_list_id;
      const wantName = isSegment ? src.config.klaviyo_segment_name : src.config.klaviyo_list_name;
      if (!listId && wantName) {
        const groups = isSegment ? await getSegments() : await getLists();
        listId = groups.find((l) => l.name.toLowerCase() === wantName.toLowerCase())?.id;
        if (listId) {
          const idKey = isSegment ? "klaviyo_segment_id" : "klaviyo_list_id";
          await db
            .from("intake_sources")
            .update({ config: { ...src.config, [idKey]: listId }, updated_at: new Date().toISOString() })
            .eq("id", src.id);
        }
      }
      if (!listId) {
        summary[src.label] = isSegment ? "segment not found" : "list not found";
        continue;
      }

      const cursorKey = `intake:${src.adapter}:${src.id}`;
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

      const members = isSegment ? await getRecentSegmentMembers(listId, 50) : await getRecentListMembers(listId, 50);
      const fresh = members.filter((m) => m.joinedAt && m.joinedAt > cursor!);
      const counts: Record<string, number> = {};
      let maxJoined = cursor;
      // Oldest-first so the round-robin order matches join order.
      for (const m of fresh.reverse()) {
        const props = m.properties ?? {};
        const noteBits = ["notes_summary", "notes", "Notes Summary"]
          .map((k) => props[k])
          .filter((v) => typeof v === "string" && (v as string).trim());
        // Identity moment: the member's Klaviyo profile carries our attr_*
        // stamps (incl. attr_vid) when attr.js saw this browser — link the
        // anonymous touch history + merge attribution onto the contact.
        if (m.email) {
          try {
            const { touchesFromFlat, mergeContactAttribution, linkVisitor } = await import("@/lib/attribution");
            await mergeContactAttribution(db, m.email, touchesFromFlat(props));
            await linkVisitor(db, props, m.email);
          } catch {}
        }
        const res = await processIntake(db, src, {
          // Join-scoped: a profile RE-entering (re-engaged, re-applied) processes
          // again as a fresh funnel touch instead of being dedupe-swallowed.
          externalId: `${m.profileId}:${m.joinedAt ?? ""}`,
          email: m.email,
          phone: m.phone,
          name: [m.firstName, m.lastName].filter(Boolean).join(" ") || null,
          note: (noteBits[0] as string) ?? null,
          occurredAt: m.joinedAt,
          meta: {
            klaviyo_group_id: listId,
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
