import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { getLists, getRecentListMembers, getMetrics, getEventsForMetric, getProfileByEmail } from "@/lib/klaviyo";
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
    .in("adapter", ["klaviyo_list", "klaviyo_metric"])
    .eq("enabled", true);
  if (!sources || sources.length === 0) return NextResponse.json({ ok: true, enabled: 0 });

  const summary: Record<string, unknown> = {};

  // ── Metric-event engines ──
  for (const src of (sources as IntakeSource[]).filter((s) => s.adapter === "klaviyo_metric")) {
    try {
      const cfg = src.config as { klaviyo_metric_name?: string; klaviyo_metric_id?: string };
      let metricId = cfg.klaviyo_metric_id;
      if (!metricId && cfg.klaviyo_metric_name) {
        const metrics = await getMetrics();
        const want = cfg.klaviyo_metric_name.toLowerCase();
        metricId = (metrics.find((m) => m.name.toLowerCase() === want) ??
          metrics.find((m) => m.name.toLowerCase().includes(want)))?.id;
        if (metricId) {
          await db
            .from("intake_sources")
            .update({ config: { ...src.config, klaviyo_metric_id: metricId }, updated_at: new Date().toISOString() })
            .eq("id", src.id);
        }
      }
      if (!metricId) {
        summary[src.label] = "metric not found";
        continue;
      }

      const cursorKey = `intake:klaviyo_metric:${src.id}`;
      const { data: cur } = await db.from("crm_sync_state").select("value").eq("key", cursorKey).maybeSingle();
      let cursor = (cur?.value as any)?.last_event_at as string | undefined;
      if (!cursor) {
        cursor = new Date().toISOString();
        await db.from("crm_sync_state").upsert(
          { key: cursorKey, value: { last_event_at: cursor }, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
        summary[src.label] = "cursor initialized";
        continue;
      }

      const events = await getEventsForMetric(metricId, cursor, { fullProps: true });
      const counts: Record<string, number> = {};
      let maxAt = cursor;
      for (const ev of events) {
        if (!ev.occurredAt || ev.occurredAt <= cursor) continue;
        // Zap parity: enrich from the subscriber profile (name + phone).
        const profile = await getProfileByEmail(ev.email).catch(() => null);
        const evPhone = typeof ev.meta?.phone_number === "string" ? (ev.meta.phone_number as string) : null;
        const link = typeof ev.meta?.configuration_url === "string" ? (ev.meta.configuration_url as string) : null;
        const res = await processIntake(db, src, {
          externalId: (ev.meta?.klaviyo_event_id as string) ?? `${ev.email}:${ev.occurredAt}`,
          email: ev.email,
          phone: profile?.phoneNumber ?? evPhone,
          name: [profile?.firstName, profile?.lastName].filter(Boolean).join(" ") || null,
          link,
          occurredAt: ev.occurredAt,
          meta: { ...ev.meta, source_channel_id: src.channel_id },
        });
        counts[res.action] = (counts[res.action] ?? 0) + 1;
        if (ev.occurredAt > maxAt) maxAt = ev.occurredAt;
      }
      if (maxAt > cursor) {
        await db.from("crm_sync_state").upsert(
          { key: cursorKey, value: { last_event_at: maxAt }, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
      }
      summary[src.label] = { events: Object.values(counts).reduce((a, b) => a + b, 0), ...counts };
    } catch (e) {
      summary[src.label] = `error: ${e instanceof Error ? e.message : "failed"}`;
    }
  }
  // ── List-membership engines ──
  for (const src of (sources as (IntakeSource & { config: { klaviyo_list_id?: string; klaviyo_list_name?: string } })[]).filter(
    (s) => s.adapter === "klaviyo_list"
  )) {
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
          occurredAt: m.joinedAt,
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
