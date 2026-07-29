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
  getPersonsByIds,
  setDealLabels,
  createDueTodayActivity,
  getRecentSentThreads,
  PipedriveRateLimitError,
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
      // Supabase caps every select at 1000 rows — the 7-day window holds far
      // more, so page through explicitly (newest first).
      type Ev = { source: string; type: string; occurred_at: string; pipedrive_deal_id: number };
      const recent: Ev[] = [];
      for (let page = 0; page < 20; page++) {
        const { data, error } = await db
          .from("engagement_events")
          .select("source, type, occurred_at, pipedrive_deal_id")
          .not("pipedrive_deal_id", "is", null)
          .gte("occurred_at", scoringWindowStart)
          .order("occurred_at", { ascending: false })
          .range(page * 1000, page * 1000 + 999);
        if (error) throw new Error(error.message);
        recent.push(...((data ?? []) as Ev[]));
        if (!data || data.length < 1000) break;
      }
      const byDeal = new Map<number, Ev[]>();
      for (const ev of recent) {
        byDeal.set(ev.pipedrive_deal_id, [...(byDeal.get(ev.pipedrive_deal_id) ?? []), ev]);
      }

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
      for (const [dealId, events] of byDeal) {
        if (blocked.has(dealId)) continue;
        const verdict = evaluateDeal(events, rules, now);
        if (!verdict.hot) continue;
        if (flagged >= MAX_NEW_FLAGS_PER_SWEEP || remaining() < 20_000) {
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
        flagged++;
      }
      summary.scoring = { dealsScored: byDeal.size, flagged, ...(deferred ? { deferredToNextSweep: deferred } : {}) };
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
      let ingested = 0;
      for (const [metricName, source, type] of KLAVIYO_METRICS) {
        if (remaining() < 8_000) break;
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

  // ── 5. Match unmatched emails → deals (whatever budget remains) ──────────
  if (hasPipedrive && remaining() > 12_000) {
    try {
      const retryBefore = new Date(now.getTime() - 24 * 3600_000).toISOString();
      const { data: unmatched } = await db
        .from("engagement_events")
        .select("id, person_email, match_attempted_at")
        .is("pipedrive_deal_id", null)
        .not("person_email", "is", null)
        .gte("occurred_at", scoringWindowStart)
        .or(`match_attempted_at.is.null,match_attempted_at.lt.${retryBefore}`)
        .order("occurred_at", { ascending: false })
        .limit(500);
      const byEmail = new Map<string, number[]>();
      for (const ev of unmatched ?? []) {
        byEmail.set(ev.person_email, [...(byEmail.get(ev.person_email) ?? []), ev.id]);
      }
      let matched = 0;
      let processedEmails = 0;
      let rateLimited = false;
      for (const [email, ids] of byEmail) {
        if (remaining() < 8_000) break;
        try {
          const personId = await findPersonIdByEmail(email);
          const deals = personId ? await getOpenDealsForPerson(personId) : [];
          if (deals.length > 0) {
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
          await new Promise((r) => setTimeout(r, 150));
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
  }

  summary.elapsedMs = Date.now() - started;
  return NextResponse.json({ ok: true, summary });
}
