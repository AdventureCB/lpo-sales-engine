import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase";
import { listCallsWithParticipant, type QuoCall } from "@/lib/quo-api";

export const runtime = "nodejs";
export const maxDuration = 60;

const BUDGET_MS = 40_000;
const DEFAULT_FROM = "2026-05-01T00:00:00Z";
const CONVERSATION_MIN_S = 40; // no transcript for old calls — talk length stands in

/**
 * Backfill Quo call history for journey customers, so talk-to-deposit /
 * talk-to-confirmation cover journeys that predate live call tracking.
 * Resumable (cursor in crm_sync_state "quo_talk_backfill"); upserts preserve
 * webhook/transcript-derived classification and raw where they exist, and
 * write a participants-bearing raw for rows that lack one (reconcile-inserted
 * rows have raw NULL, which made them invisible to talk-time matching).
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? DEFAULT_FROM;
  const reset = url.searchParams.get("reset") === "1";
  const started = Date.now();

  const db = supabaseAdmin();
  const [{ data: phonesData, error: phErr }, linesRes, repsRes, stateRow] = await Promise.all([
    db.rpc("journey_backfill_phones"),
    db.from("quo_lines").select("phone_number_id").eq("active", true),
    db.from("reps").select("id, quo_user_id"),
    db.from("crm_sync_state").select("value").eq("key", "quo_talk_backfill").maybeSingle(),
  ]);
  if (phErr || linesRes.error || repsRes.error) {
    return NextResponse.json(
      { error: (phErr ?? linesRes.error ?? repsRes.error)!.message },
      { status: 500 }
    );
  }
  const phones: string[] = (phonesData ?? []).map((r: any) => r.phone);
  const lines = (linesRes.data ?? []).map((l) => l.phone_number_id);
  const repByQuoUser = new Map(
    (repsRes.data ?? []).filter((r) => r.quo_user_id).map((r) => [r.quo_user_id!, r.id])
  );

  let idx = reset ? 0 : ((stateRow.data?.value as any)?.idx ?? 0);
  let callsSeen = 0;
  let callsUpserted = 0;

  while (idx < phones.length && Date.now() - started < BUDGET_MS) {
    const phone = phones[idx];
    const calls: QuoCall[] = [];
    for (const line of lines) {
      try {
        calls.push(...(await listCallsWithParticipant({ phoneNumberId: line, participant: phone, createdAfter: from })));
      } catch (e) {
        console.error(`quo backfill ${phone} line ${line} failed`, e);
      }
    }
    callsSeen += calls.length;

    if (calls.length > 0) {
      const ids = calls.map((c) => c.id);
      const { data: existing } = await db
        .from("call_events")
        .select("quo_call_id, classification, raw")
        .in("quo_call_id", ids);
      const hasClass = new Set((existing ?? []).filter((r) => r.classification).map((r) => r.quo_call_id));
      const hasRaw = new Set((existing ?? []).filter((r) => r.raw).map((r) => r.quo_call_id));

      // Group rows by which columns they may write, so the upsert can never
      // null out webhook-derived classification or raw.
      const groups = new Map<string, Record<string, unknown>[]>();
      for (const c of calls) {
        const talkS =
          c.answeredAt && c.completedAt
            ? Math.max(0, Math.round((Date.parse(c.completedAt) - Date.parse(c.answeredAt)) / 1000))
            : null;
        const row: Record<string, unknown> = {
          quo_call_id: c.id,
          rep_id: (c.userId && repByQuoUser.get(c.userId)) || null,
          direction: c.direction,
          status: c.status,
          started_at: c.createdAt,
          answered_at: c.answeredAt,
          completed_at: c.completedAt,
          duration_s: talkS ?? c.duration,
        };
        if (!hasClass.has(c.id)) {
          row.classification = !c.answeredAt
            ? "no_answer"
            : (talkS ?? 0) >= CONVERSATION_MIN_S
              ? "conversation"
              : "screening";
        }
        if (!hasRaw.has(c.id)) {
          row.raw = {
            backfill: true,
            data: { object: { participants: c.participants ?? [phone], userId: c.userId ?? null } },
          };
        }
        const key = `${row.classification !== undefined}|${row.raw !== undefined}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      for (const batch of groups.values()) {
        const { error } = await db
          .from("call_events")
          .upsert(batch, { onConflict: "quo_call_id", ignoreDuplicates: false });
        if (error) {
          return NextResponse.json({ error: error.message, idx }, { status: 500 });
        }
        callsUpserted += batch.length;
      }
    }

    idx++;
    await db
      .from("crm_sync_state")
      .upsert({ key: "quo_talk_backfill", value: { idx, from } }, { onConflict: "key" });
  }

  return NextResponse.json({
    ok: true,
    done: idx >= phones.length,
    idx,
    totalPhones: phones.length,
    callsSeen,
    callsUpserted,
  });
}
