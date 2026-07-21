import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase";
import { envOptional } from "@/lib/env";
import { getMetricIds, getEventsForMetric } from "@/lib/klaviyo";
import {
  findPersonIdByEmail,
  getOpenDealsForPerson,
  getHotLabelId,
  getDeal,
  setDealLabels,
  createDueTodayActivity,
  getRecentSentThreads,
  PipedriveRateLimitError,
} from "@/lib/pipedrive";
import { normalizeEmail } from "@/lib/identity";
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
];

/**
 * Hot-list sweep (every 15 min via Supabase pg_cron):
 * 1. Ingest Klaviyo open/click events → engagement_events (idempotent).
 * 2. Resolve person emails → open Pipedrive deals.
 * 3. Score each deal against app_config.hot_rules.
 * 4. Flag: hot_flags row + "🔥 Hot" label + due-today activity (cooldown-aware).
 * 5. Quiet-clear: unflag deals silent for quiet_clear_days.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = supabaseAdmin();
  const summary: Record<string, unknown> = {};
  const now = new Date();

  const { data: config } = await db.from("app_config").select("hot_rules").single();
  const rules: HotRules = { ...DEFAULT_RULES, ...((config?.hot_rules as object) ?? {}) };

  // ── 1. Ingest Klaviyo ─────────────────────────────────────────────────────
  if (envOptional("KLAVIYO_PRIVATE_KEY")) {
    try {
      const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
      const metricIds = await getMetricIds();
      let ingested = 0;
      for (const [metricName, source, type] of KLAVIYO_METRICS) {
        const metricId = metricIds.get(metricName);
        if (!metricId) continue;
        const events = await getEventsForMetric(metricId, since);
        if (events.length === 0) continue;
        const rows = events.map((e) => ({
          source,
          type,
          person_email: e.email,
          occurred_at: e.occurredAt,
          meta: e.meta,
        }));
        const { error } = await db.from("engagement_events").upsert(rows, {
          onConflict: "source,type,person_email,occurred_at",
          ignoreDuplicates: true,
        });
        if (error) throw new Error(error.message);
        ingested += rows.length;
      }
      summary.klaviyo = { ingested };
    } catch (e) {
      console.error("klaviyo ingest failed", e);
      summary.klaviyo = { error: e instanceof Error ? e.message : String(e) };
    }
  } else {
    summary.klaviyo = "skipped: KLAVIYO_PRIVATE_KEY not set";
  }

  if (!envOptional("PIPEDRIVE_API_TOKEN")) {
    summary.pipedrive = "skipped: PIPEDRIVE_API_TOKEN not set";
    return NextResponse.json({ ok: true, summary });
  }

  // ── 1b. Ingest Pipedrive rep-email opens ──────────────────────────────────
  // Sent threads carry mail_tracking_status AND a direct deal_id — no email
  // matching needed. occurred_at = last_message_timestamp keeps the event
  // stable across sweeps, so the unique constraint dedupes re-observations.
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
        // NULL emails would bypass the dedupe constraint (NULLs compare
        // distinct) and duplicate on every sweep — skip those rare threads.
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

  // ── 2. Resolve unmatched recent events to deals ───────────────────────────
  const scoringWindowStart = new Date(
    now.getTime() - rules.opens_window_days * 24 * 3600_000
  ).toISOString();
  try {
    // Skip emails we already tried recently — most marketing recipients have
    // no Pipedrive person, and re-searching them every sweep trips the limit.
    const retryBefore = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const { data: unmatched } = await db
      .from("engagement_events")
      .select("id, person_email, match_attempted_at")
      .is("pipedrive_deal_id", null)
      .not("person_email", "is", null)
      .gte("occurred_at", scoringWindowStart)
      .or(`match_attempted_at.is.null,match_attempted_at.lt.${retryBefore}`)
      .limit(500);
    const byEmail = new Map<string, number[]>();
    for (const ev of unmatched ?? []) {
      byEmail.set(ev.person_email, [...(byEmail.get(ev.person_email) ?? []), ev.id]);
    }
    const MAX_EMAILS_PER_SWEEP = 120; // backlog drains across 15-min sweeps
    let matched = 0;
    let processedEmails = 0;
    let rateLimited = false;
    for (const [email, ids] of byEmail) {
      if (processedEmails >= MAX_EMAILS_PER_SWEEP) break;
      try {
        const personId = await findPersonIdByEmail(email);
        const deals = personId ? await getOpenDealsForPerson(personId) : [];
        if (deals.length > 0) {
          // Multiple open deals is rare; attach the signal to the first.
          const { error } = await db
            .from("engagement_events")
            .update({ pipedrive_deal_id: deals[0].id })
            .in("id", ids);
          if (error) throw new Error(error.message);
          matched += ids.length;
        }
        await db
          .from("engagement_events")
          .update({ match_attempted_at: now.toISOString() })
          .in("id", ids);
        processedEmails++;
        await new Promise((r) => setTimeout(r, 250)); // ~4 req/s, under the bucket
      } catch (e) {
        if (e instanceof PipedriveRateLimitError) {
          rateLimited = true;
          break; // resume next sweep
        }
        throw e;
      }
    }
    summary.matching = {
      candidateEmails: byEmail.size,
      processedEmails,
      matched,
      ...(rateLimited ? { rateLimited: true } : {}),
    };
  } catch (e) {
    console.error("deal matching failed", e);
    summary.matching = { error: e instanceof Error ? e.message : String(e) };
  }

  // ── 3–4. Score and flag ───────────────────────────────────────────────────
  try {
    const { data: recent } = await db
      .from("engagement_events")
      .select("source, type, occurred_at, pipedrive_deal_id")
      .not("pipedrive_deal_id", "is", null)
      .gte("occurred_at", scoringWindowStart);
    const byDeal = new Map<number, typeof recent>();
    for (const ev of recent ?? []) {
      byDeal.set(ev.pipedrive_deal_id, [...(byDeal.get(ev.pipedrive_deal_id) ?? []), ev]);
    }

    const hotLabelId = await getHotLabelId().catch(() => null);
    let flagged = 0;
    for (const [dealId, events] of byDeal) {
      const verdict = evaluateDeal(events!, rules, now);
      if (!verdict.hot) continue;

      const { data: lastFlag } = await db
        .from("hot_flags")
        .select("id, cooldown_until, cleared_at")
        .eq("deal_id", dealId)
        .order("flagged_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const inCooldown = lastFlag?.cooldown_until && new Date(lastFlag.cooldown_until) > now;
      const activeFlag = lastFlag && !lastFlag.cleared_at && !inCooldown;
      if (inCooldown || activeFlag) continue;

      const deal = await getDeal(dealId).catch(() => null);
      if (!deal || deal.status !== "open") continue;

      const { error } = await db.from("hot_flags").insert({
        deal_id: dealId,
        reason: verdict.reason,
        signals: verdict.signals,
        deal_title: deal.title,
        owner_name: deal.owner_name ?? null,
        cooldown_until: new Date(
          now.getTime() + rules.cooldown_days * 24 * 3600_000
        ).toISOString(),
      });
      // 23505 = a concurrent sweep already flagged this deal (unique index
      // on active flags) — skip side-effects so tasks aren't duplicated.
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
      flagged++;
    }
    summary.scoring = { dealsScored: byDeal.size, flagged };
  } catch (e) {
    console.error("scoring failed", e);
    summary.scoring = { error: e instanceof Error ? e.message : String(e) };
  }

  // ── 5. Quiet-clear ────────────────────────────────────────────────────────
  try {
    const quietCutoff = new Date(
      now.getTime() - rules.quiet_clear_days * 24 * 3600_000
    ).toISOString();
    const { data: staleFlags } = await db
      .from("hot_flags")
      .select("id, deal_id")
      .is("cleared_at", null)
      .lt("flagged_at", quietCutoff);
    const hotLabelId = await getHotLabelId().catch(() => null);
    let cleared = 0;
    for (const flag of staleFlags ?? []) {
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

  return NextResponse.json({ ok: true, summary });
}
