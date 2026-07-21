import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase";
import { getCallTranscript, listCallsForNumber, quoPool, type QuoCall } from "@/lib/quo-api";
import { classifyTranscript } from "@/lib/classify";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_LOOKBACK_HOURS = 48;

/**
 * Call reconciliation (Module 3): pull calls per rep phone number — real
 * timestamps/direction/duration — and upsert anything webhooks missed.
 * Classification and disposition columns are deliberately NOT in the upsert
 * payload so webhook/transcript-derived values survive.
 *
 * ?hours=N bounds the window: Supabase pg_cron sweeps hourly with a short
 * window; Vercel's nightly cron does the 48h deep pass.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const hoursParam = Number(new URL(req.url).searchParams.get("hours"));
  const lookbackHours =
    Number.isFinite(hoursParam) && hoursParam >= 1 && hoursParam <= 168
      ? hoursParam
      : DEFAULT_LOOKBACK_HOURS;

  const db = supabaseAdmin();
  const { data: reps, error: repsError } = await db
    .from("reps")
    .select("id, name, quo_user_id, quo_phone_number_id")
    .eq("active", true)
    .not("quo_phone_number_id", "is", null);
  if (repsError) {
    return NextResponse.json({ error: repsError.message }, { status: 500 });
  }

  const createdAfter = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
  const results: Array<Record<string, unknown>> = [];

  // Sequential per rep to stay under Quo's 10 req/s; one rep failing
  // (e.g. API shape change) must not sink the others. No userId scoping —
  // reconciliation is per NUMBER; the number's owner is the rep.
  for (const rep of reps ?? []) {
    try {
      const calls = await listCallsForNumber({
        phoneNumberId: rep.quo_phone_number_id!,
        createdAfter,
      });

      // Classify calls that don't already have a classification (webhook
      // transcripts or a prior sweep may have set one — never refetch those).
      const { data: existing } = await db
        .from("call_events")
        .select("quo_call_id")
        .in("quo_call_id", calls.map((c) => c.id))
        .not("classification", "is", null);
      const alreadyClassified = new Set((existing ?? []).map((r) => r.quo_call_id));

      let transcriptsFetched = 0;
      const rows = await quoPool(calls, async (c: QuoCall) => {
        let classification: string | null = null;
        if (!alreadyClassified.has(c.id)) {
          if (!c.answeredAt) {
            classification = "no_answer";
          } else {
            const dialogue = await getCallTranscript(c.id).catch(() => null);
            if (dialogue) {
              transcriptsFetched++;
              classification = classifyTranscript(
                dialogue.map((d) => ({
                  speaker: d.userId ? ("rep" as const) : ("contact" as const),
                  text: d.content ?? "",
                }))
              );
            }
          }
        }
        return {
          quo_call_id: c.id,
          rep_id: rep.id,
          direction: c.direction,
          status: c.status,
          started_at: c.createdAt,
          answered_at: c.answeredAt,
          completed_at: c.completedAt,
          // talk seconds = answered→completed; Quo's `duration` spans ring time
          duration_s:
            c.answeredAt && c.completedAt
              ? Math.max(0, Math.round((Date.parse(c.completedAt) - Date.parse(c.answeredAt)) / 1000))
              : c.duration,
          classification,
        };
      });

      // Two batches: rows without a fresh classification must omit the column
      // entirely so the upsert can't null out webhook-set values.
      const withClass = rows.filter((r) => r.classification !== null);
      const withoutClass = rows
        .filter((r) => r.classification === null)
        .map(({ classification, ...rest }) => rest);
      for (const batch of [withClass, withoutClass]) {
        if (batch.length === 0) continue;
        const { error } = await db
          .from("call_events")
          .upsert(batch, { onConflict: "quo_call_id", ignoreDuplicates: false });
        if (error) throw new Error(error.message);
      }
      results.push({ rep: rep.name, reconciled: rows.length, classified: withClass.length, transcriptsFetched });
    } catch (e) {
      console.error(`reconcile failed for ${rep.name}`, e);
      results.push({ rep: rep.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({ ok: true, lookbackHours, results });
}
