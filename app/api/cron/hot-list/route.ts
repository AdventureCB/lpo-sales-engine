import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase";
import { envOptional } from "@/lib/env";
import { getMetricIds, getEventsForMetric, metricSlug } from "@/lib/klaviyo";
import {
  getHotLabelId,
  getDeal,
  getPersonsByIds,
  setDealLabels,
  createDueTodayActivity,
  getRecentSentThreads,
} from "@/lib/pipedrive";
import { normalizePhone, normalizeEmail } from "@/lib/identity";
import { evaluateDeal, DEFAULT_RULES, type HotRules } from "@/lib/hotlist";

export const runtime = "nodejs";
export const maxDuration = 60;

// [Klaviyo metric name, stored source, stored type]. Shopify-originated
// events reach us through Klaviyo's integration, but keep their true source
// so the "distinct signal types" rule sees e.g. email_open + builder_save.
const KLAVIYO_METRICS: Array<[string, string, string]> = [
  ["Opened Email", "klaviyo", "email_open"],
  ["Clicked Email", "klaviyo", "email_click"],
  ["3D Builder - Save Build", "shopify", "builder_save"],
  ["Checkout Started", "shopify", "checkout_started"],
  // Purchase signals — used to EXCLUDE already-bought contacts from Hot List
  // Import recovery (see hotlist_recovery_candidates). Harmless if a metric
  // isn't present in this Klaviyo account (id lookup just skips it).
  ["Placed Order", "shopify", "placed_order"],
  ["Ordered Product", "shopify", "ordered_product"],
  ["Fulfilled Order", "shopify", "fulfilled_order"],
];

const BUDGET_MS = 50_000; // hard stop before Vercel's 60s kill
const MAX_NEW_FLAGS_PER_SWEEP = 15;
const MAX_QUIET_CLEARS_PER_SWEEP = 10;

/**
 * Hot-list sweep (every 15 min via Supabase pg_cron). Runs stages in
 * PRIORITY order under a time budget — every stage makes progress across
 * sweeps even when one is slow, instead of the old serial pipeline where a
 * slow early stage starved scoring until the 60s kill:
 *   1. Score + flag (the user-visible outcome)
 *   2. Quiet-clear stale flags (bounded batch)
 *   3. Ingest Klaviyo (short window; ?hours=N for the nightly deep pass)
 *   4. Ingest Pipedrive rep-mail opens
 *   5. Match unmatched emails → deals (uses whatever budget remains)
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const remaining = () => BUDGET_MS - (Date.now() - started);
  const db = supabaseAdmin();
  const summary: Record<string, unknown> = {};
  const now = new Date();

  const hoursParam = Number(new URL(req.url).searchParams.get("hours"));
  const ingestHours = Number.isFinite(hoursParam) && hoursParam >= 1 && hoursParam <= 168 ? hoursParam : 3;

  const { data: config } = await db.from("app_config").select("hot_rules").single();
  const rules: HotRules = { ...DEFAULT_RULES, ...((config?.hot_rules as object) ?? {}) };
  const scoringWindowStart = new Date(
    now.getTime() - rules.opens_window_days * 24 * 3600_000
  ).toISOString();
  const hasPipedrive = Boolean(envOptional("PIPEDRIVE_API_TOKEN"));

  // ── 1. Score and flag ─────────────────────────────────────────────────────
  if (hasPipedrive) {
    try {
      // Aggregates computed in Postgres — one round-trip, regardless of how
      // many events the window holds.
      const { data: candidates, error: rpcError } = await db.rpc("score_hot_candidates", {
        window_start: scoringWindowStart,
        click_window_hours: rules.click_window_hours,
        distinct_window_hours: rules.distinct_signal_window_hours,
      });
      if (rpcError) throw new Error(rpcError.message);

      // One query for every deal currently blocked from re-flagging
      // (active flag or cooldown) — not a round-trip per candidate.
      const blocked = new Set<number>();
      for (let page = 0; page < 5; page++) {
        const { data } = await db
          .from("hot_flags")
          .select("deal_id, cleared_at, cooldown_until")
          .or(`cleared_at.is.null,cooldown_until.gt.${now.toISOString()}`)
          .range(page * 1000, page * 1000 + 999);
        for (const f of data ?? []) blocked.add(f.deal_id);
        if (!data || data.length < 1000) break;
      }

      const hotLabelId = await getHotLabelId().catch(() => null);
      let flagged = 0;
      let deferred = 0;
      for (const c of (candidates ?? []) as Array<{
        deal_id: number;
        opens: number;
        clicks: number;
        distinct_types: number;
      }>) {
        const dealId = c.deal_id;
        if (blocked.has(dealId)) continue;
        const reasons: string[] = [];
        if (c.opens >= rules.opens_in_window)
          reasons.push(`${c.opens} opens in ${rules.opens_window_days}d`);
        if (c.clicks > 0) reasons.push(`click in last ${rules.click_window_hours}h`);
        if (c.distinct_types >= rules.distinct_signal_types)
          reasons.push(`${c.distinct_types} signal types in ${rules.distinct_signal_window_hours}h`);
        if (reasons.length === 0) continue;
        const verdict = {
          reason: reasons.join(" · "),
          signals: { opens: c.opens, clicks: c.clicks, distinctTypes: c.distinct_types },
        };
        if (flagged >= MAX_NEW_FLAGS_PER_SWEEP || remaining() < 12_000) {
          deferred++;
          continue;
        }

        const deal = await getDeal(dealId).catch(() => null);
        if (!deal || deal.status !== "open") continue;

        let personPhone: string | null = null;
        if (deal.person_id) {
          const persons = await getPersonsByIds([deal.person_id]).catch(() => null);
          personPhone = normalizePhone(persons?.get(deal.person_id)?.phone);
        }

        const { error } = await db.from("hot_flags").insert({
          deal_id: dealId,
          reason: verdict.reason,
          signals: verdict.signals,
          deal_title: deal.title,
          owner_name: deal.owner_name ?? null,
          owner_pipedrive_id: deal.owner_id ?? null,
          person_phone: personPhone,
          cooldown_until: new Date(
            now.getTime() + rules.cooldown_days * 24 * 3600_000
          ).toISOString(),
        });
        // 23505 = a concurrent sweep already flagged this deal.
        if (error?.code === "23505") continue;
        if (error) throw new Error(error.message);

        // Pipedrive side-effects are best-effort — a failure there must not
        // roll back the flag (the dashboard still shows it).
        try {
          if (hotLabelId && !deal.label_ids.includes(hotLabelId)) {
            await setDealLabels(dealId, [...deal.label_ids, hotLabelId]);
          }
          await createDueTodayActivity({
            dealId,
            ownerId: deal.owner_id,
            subject: `Hot: ${verdict.reason} — call today`,
          });
        } catch (e) {
          console.error(`pipedrive side-effects failed for deal ${dealId}`, e);
        }
        {
          const { enqueueEvent } = await import("@/lib/automations");
          await enqueueEvent(db, "hot_flag_created", {
            pipedrive_deal_id: dealId,
            reason: verdict.reason,
          });
        }
        flagged++;
      }
      summary.scoring = {
        dealsScored: (candidates ?? []).length,
        flagged,
        ...(deferred ? { deferredToNextSweep: deferred } : {}),
      };
    } catch (e) {
      console.error("scoring failed", e);
      summary.scoring = { error: e instanceof Error ? e.message : String(e) };
    }
  } else {
    summary.scoring = "skipped: PIPEDRIVE_API_TOKEN not set";
  }

  // ── 2. Quiet-clear (bounded batch) ────────────────────────────────────────
  if (hasPipedrive && remaining() > 15_000) {
    try {
      const quietCutoff = new Date(
        now.getTime() - rules.quiet_clear_days * 24 * 3600_000
      ).toISOString();
      const { data: staleFlags } = await db
        .from("hot_flags")
        .select("id, deal_id")
        .is("cleared_at", null)
        .lt("flagged_at", quietCutoff)
        .order("flagged_at", { ascending: true })
        .limit(MAX_QUIET_CLEARS_PER_SWEEP);
      const hotLabelId = await getHotLabelId().catch(() => null);
      let cleared = 0;
      for (const flag of staleFlags ?? []) {
        if (remaining() < 10_000) break;
        const { count } = await db
          .from("engagement_events")
          .select("id", { count: "exact", head: true })
          .eq("pipedrive_deal_id", flag.deal_id)
          .gte("occurred_at", quietCutoff);
        if ((count ?? 0) > 0) continue;
        await db.from("hot_flags").update({ cleared_at: now.toISOString() }).eq("id", flag.id);
        if (hotLabelId) {
          try {
            const deal = await getDeal(flag.deal_id);
            if (deal.label_ids.includes(hotLabelId)) {
              await setDealLabels(flag.deal_id, deal.label_ids.filter((l) => l !== hotLabelId));
            }
          } catch (e) {
            console.error(`label removal failed for deal ${flag.deal_id}`, e);
          }
        }
        cleared++;
      }
      summary.quietClear = { cleared };
    } catch (e) {
      console.error("quiet-clear failed", e);
      summary.quietClear = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── 3. Ingest Klaviyo ─────────────────────────────────────────────────────
  if (envOptional("KLAVIYO_PRIVATE_KEY") && remaining() > 12_000) {
    try {
      const since = new Date(now.getTime() - ingestHours * 3600_000).toISOString();
      const metricIds = await getMetricIds();

      // Metric list is dynamic: the built-ins plus any Klaviyo metric an
      // enabled automation triggers on (Typeform / Shopify / Gorgias events
      // all arrive through Klaviyo). Trigger metrics keep full properties
      // so templates can port any field.
      const { data: enabledAutos } = await db
        .from("crm_automations")
        .select("trigger")
        .eq("enabled", true);
      const triggerSlugs = new Set<string>();
      const metricList: Array<[string, string, string]> = [...KLAVIYO_METRICS];
      for (const a of enabledAutos ?? []) {
        const t = a.trigger as { type?: string; signal_type?: string; metric_name?: string };
        if (t.type !== "signal_received") continue;
        if (t.signal_type) triggerSlugs.add(t.signal_type);
        if (t.metric_name && !metricList.some(([name]) => name === t.metric_name)) {
          metricList.push([t.metric_name, "klaviyo", metricSlug(t.metric_name)]);
        }
      }

      let ingested = 0;
      for (const [metricName, source, type] of metricList) {
        if (remaining() < 8_000) break;
        const metricId = metricIds.get(metricName);
        if (!metricId) continue;
        const events = await getEventsForMetric(metricId, since, {
          fullProps: triggerSlugs.has(type),
        });
        if (events.length === 0) continue;
        const rows = events.map((e) => ({
          source,
          type,
          person_email: e.email,
          occurred_at: e.occurredAt,
          meta: e.meta,
        }));
        const { data: inserted, error } = await db
          .from("engagement_events")
          .upsert(rows, {
            onConflict: "source,type,person_email,occurred_at",
            ignoreDuplicates: true,
          })
          .select("id, type, person_email, meta");
        if (error) throw new Error(error.message);
        ingested += rows.length;
        // Any signal type an enabled automation triggers on feeds the
        // engine (only newly inserted rows come back from an
        // ignore-duplicates upsert — no double-firing).
        if (triggerSlugs.has(type)) {
          const { enqueueEvent } = await import("@/lib/automations");
          for (const ev of inserted ?? []) {
            await enqueueEvent(db, "signal_received", {
              signal_type: ev.type,
              person_email: ev.person_email,
              meta: ev.meta,
            });
          }
        }
      }
      summary.klaviyo = { ingested, windowHours: ingestHours };
    } catch (e) {
      console.error("klaviyo ingest failed", e);
      summary.klaviyo = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── 4. Ingest Pipedrive rep-email opens ───────────────────────────────────
  if (hasPipedrive && remaining() > 10_000) {
    try {
      const mailSince = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
      const threads = await getRecentSentThreads(mailSince);
      const opened = threads.filter(
        (t) => t.mail_tracking_status === "opened" && t.last_message_timestamp
      );
      if (opened.length > 0) {
        const rows = opened
          .map((t) => ({
            source: "pipedrive",
            type: "email_open",
            person_email: normalizeEmail(t.to_email),
            pipedrive_deal_id: t.deal_id,
            occurred_at: t.last_message_timestamp!,
            meta: { thread_id: t.id, subject: t.subject },
          }))
          // NULL emails would bypass the dedupe constraint — skip those.
          .filter((r) => r.person_email);
        const { error } = await db.from("engagement_events").upsert(rows, {
          onConflict: "source,type,person_email,occurred_at",
          ignoreDuplicates: true,
        });
        if (error) throw new Error(error.message);
      }
      summary.pipedriveMail = { threadsScanned: threads.length, opened: opened.length };
    } catch (e) {
      console.error("pipedrive mail ingest failed", e);
      summary.pipedriveMail = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── 5. Match unmatched signals → deals (CRM-native) ───────────────────────
  // Matching is now a single indexed Postgres statement against the CRM mirror
  // (crm_contacts email GIN → open crm_deals) — NO Pipedrive, no per-email
  // round-trips, no 25/sweep cap. The old live-Pipedrive path was diet-capped
  // so hard that ~86% of signals never attached to a deal, so nothing scored.
  if (remaining() > 6_000) {
    try {
      const { data: matched, error } = await db.rpc("match_engagement_to_deals", {
        p_window_start: scoringWindowStart,
      });
      if (error) throw new Error(error.message);
      summary.matching = { matched: matched ?? 0, native: true };
    } catch (e) {
      console.error("native deal matching failed", e);
      summary.matching = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── 6. Recover deals for hot no-deal contacts (CRM-native) ────────────────
  // Contacts whose recent signals qualify but who have no OPEN deal: create a
  // new deal (Cainen-owned → reprospect pool) or reopen a closed one to its
  // previous owner. No-op unless the "Hot List Import" engine is enabled.
  // The OWNING engines (Saved Build etc.) run FIRST so a fresh buy signal is
  // claimed by its dedicated engine, not the generic safety net.
  if (remaining() > 8_000) {
    try {
      const { runKlaviyoMetricEngines } = await import("@/lib/klaviyo-metric-engines");
      summary.metricEngines = await runKlaviyoMetricEngines(db);
    } catch (e) {
      console.error("metric engines failed", e);
      summary.metricEngines = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (remaining() > 8_000) {
    try {
      const { runHotlistRecovery } = await import("@/lib/hotlist-recovery");
      summary.recovery = await runHotlistRecovery(db, { deadline: started + BUDGET_MS - 4_000 });
    } catch (e) {
      console.error("hotlist recovery failed", e);
      summary.recovery = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  summary.elapsedMs = Date.now() - started;
  return NextResponse.json({ ok: true, summary });
}
