import type { SupabaseClient } from "@supabase/supabase-js";
import { getMetrics, getEventsForMetric, getProfileByEmail } from "./klaviyo";
import { processIntake, type IntakeSource } from "./intake";

/**
 * Metric-event intake engines (e.g. Saved Build): poll each engine's Klaviyo
 * metric cursor and feed new events through processIntake with subscriber
 * enrichment. Extracted from the klaviyo-lists cron so the 15-min hot-list
 * sweep can ALSO run it BEFORE Hot List Import recovery — the owning engine
 * gets first crack at a fresh buy signal whenever the data is available.
 * Cursor-idempotent: an extra run costs one events query per engine.
 */
export async function runKlaviyoMetricEngines(db: SupabaseClient): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {};
  const { data: sources } = await db
    .from("intake_sources")
    .select("id, channel_id, label, adapter, enabled, config")
    .eq("adapter", "klaviyo_metric")
    .eq("enabled", true);

  for (const src of (sources ?? []) as IntakeSource[]) {
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
        // Identity moment (e.g. a builder save submits an email): harvest the
        // profile's attr_* stamps — link the anonymous browser's touch
        // history and merge attribution onto the contact.
        if (ev.email && profile?.properties) {
          try {
            const { touchesFromFlat, mergeContactAttribution, linkVisitor } = await import("./attribution");
            await mergeContactAttribution(db, ev.email, touchesFromFlat(profile.properties));
            await linkVisitor(db, profile.properties, ev.email);
          } catch {}
        }
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
  return summary;
}
