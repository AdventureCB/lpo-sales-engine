import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getCallTranscript,
  listCallsForNumber,
  listMessagesForNumber,
  quoPool,
  type QuoCall,
} from "@/lib/quo-api";
import { classifyTranscript } from "@/lib/classify";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_LOOKBACK_HOURS = 48;

/**
 * Call + message reconciliation (Module 3): sweep every workspace line
 * (quo_lines, shared inboxes included) and attribute each call/text to the
 * rep who handled it (userId → reps.quo_user_id) — matching how Quo
 * analytics counts. Calls handled by non-reps land with rep_id null.
 *
 * Classification and disposition columns are deliberately NOT in the upsert
 * payload for already-classified calls so webhook/transcript-derived values
 * survive. ?hours=N bounds the window: Supabase pg_cron sweeps hourly with a
 * short window; Vercel's nightly cron does the 48h deep pass.
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
  const [linesRes, repsRes] = await Promise.all([
    db.from("quo_lines").select("phone_number_id, label").eq("active", true),
    db.from("reps").select("id, quo_user_id, quo_phone_number_id"),
  ]);
  if (linesRes.error || repsRes.error) {
    return NextResponse.json(
      { error: (linesRes.error ?? repsRes.error)!.message },
      { status: 500 }
    );
  }
  const repByQuoUser = new Map(
    (repsRes.data ?? []).filter((r) => r.quo_user_id).map((r) => [r.quo_user_id!, r.id])
  );
  const repByQuoNumber = new Map(
    (repsRes.data ?? [])
      .filter((r) => r.quo_phone_number_id)
      .map((r) => [r.quo_phone_number_id!, r.id])
  );

  const createdAfter = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
  const results: Array<Record<string, unknown>> = [];

  // Sequential per line to stay under Quo's 10 req/s; one line failing must
  // not sink the others.
  for (const line of linesRes.data ?? []) {
    try {
      const [calls, messages] = [
        await listCallsForNumber({ phoneNumberId: line.phone_number_id, createdAfter }),
        await listMessagesForNumber({ phoneNumberId: line.phone_number_id, createdAfter }),
      ];

      // Classify calls that don't already have a classification (webhook
      // transcripts or a prior sweep may have set one — never refetch those).
      const { data: existing } = await db
        .from("call_events")
        .select("quo_call_id")
        .in("quo_call_id", calls.map((c) => c.id))
        .not("classification", "is", null);
      const alreadyClassified = new Set((existing ?? []).map((r) => r.quo_call_id));

      const callRows = await quoPool(calls, async (c: QuoCall) => {
        let classification: string | null = null;
        if (!alreadyClassified.has(c.id)) {
          if (!c.answeredAt) {
            classification = "no_answer";
          } else {
            const dialogue = await getCallTranscript(c.id).catch(() => null);
            if (dialogue) {
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
          rep_id: (c.userId && repByQuoUser.get(c.userId)) || null,
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
      const withClass = callRows.filter((r) => r.classification !== null);
      const withoutClass = callRows
        .filter((r) => r.classification === null)
        .map(({ classification, ...rest }) => rest);
      for (const batch of [withClass, withoutClass]) {
        if (batch.length === 0) continue;
        const { error } = await db
          .from("call_events")
          .upsert(batch, { onConflict: "quo_call_id", ignoreDuplicates: false });
        if (error) throw new Error(error.message);
      }

      if (messages.length > 0) {
        const lineOwnerRepId = repByQuoNumber.get(line.phone_number_id) ?? null;
        const messageRows = messages.map((m) => ({
          quo_message_id: m.id,
          rep_id:
            (m.userId && repByQuoUser.get(m.userId)) ||
            (m.direction === "incoming" ? lineOwnerRepId : null),
          phone_number_id: line.phone_number_id,
          direction: m.direction,
          status: m.status,
          sent_at: m.createdAt,
        }));
        const { error } = await db
          .from("message_events")
          .upsert(messageRows, { onConflict: "quo_message_id", ignoreDuplicates: false });
        if (error) throw new Error(error.message);
      }

      results.push({
        line: line.label,
        calls: callRows.length,
        classified: withClass.length,
        messages: messages.length,
      });
    } catch (e) {
      console.error(`reconcile failed for line ${line.label}`, e);
      results.push({ line: line.label, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({ ok: true, lookbackHours, results });
}
