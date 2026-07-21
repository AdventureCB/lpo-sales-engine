import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase";
import { listCalls } from "@/lib/quo-api";

export const runtime = "nodejs";
export const maxDuration = 60;

const LOOKBACK_HOURS = 48;

/**
 * Nightly call reconciliation (Module 3): pull GET /v1/calls per rep phone
 * number — real timestamps/direction/duration — and upsert anything webhooks
 * missed. Classification and disposition columns are deliberately NOT in the
 * upsert payload so webhook/transcript-derived values survive. Runs 08:30 UTC
 * ≈ 00:30/01:30 America/Los_Angeles.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = supabaseAdmin();
  const { data: reps, error: repsError } = await db
    .from("reps")
    .select("id, name, quo_user_id, quo_phone_number_id")
    .eq("active", true)
    .not("quo_phone_number_id", "is", null);
  if (repsError) {
    return NextResponse.json({ error: repsError.message }, { status: 500 });
  }

  const createdAfter = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const results: Array<Record<string, unknown>> = [];

  // Sequential per rep to stay far under Quo's 10 req/s; one rep failing
  // (e.g. API shape change) must not sink the others.
  for (const rep of reps ?? []) {
    try {
      const calls = await listCalls({
        phoneNumberId: rep.quo_phone_number_id!,
        userId: rep.quo_user_id ?? undefined,
        createdAfter,
      });
      const rows = calls.map((c) => ({
        quo_call_id: c.id,
        rep_id: rep.id,
        direction: c.direction,
        status: c.status,
        started_at: c.createdAt,
        answered_at: c.answeredAt,
        completed_at: c.completedAt,
        duration_s: c.duration,
      }));
      if (rows.length > 0) {
        const { error } = await db
          .from("call_events")
          .upsert(rows, { onConflict: "quo_call_id", ignoreDuplicates: false });
        if (error) throw new Error(error.message);
      }
      results.push({ rep: rep.name, reconciled: rows.length });
    } catch (e) {
      console.error(`reconcile failed for ${rep.name}`, e);
      results.push({ rep: rep.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({ ok: true, lookbackHours: LOOKBACK_HOURS, results });
}
