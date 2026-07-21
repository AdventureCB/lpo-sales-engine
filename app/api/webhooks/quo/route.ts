import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyQuoSignature } from "@/lib/quo";
import { classifyTranscript, type Utterance } from "@/lib/classify";

export const runtime = "nodejs";

/**
 * Quo call-lifecycle webhooks (primary live ingestion; nightly GET /v1/calls
 * reconciliation catches misses — Phase 1). Events upsert into call_events
 * keyed on quo_call_id, so ringing → completed → transcript deliveries each
 * enrich the same row. Transcript events store classification + duration only,
 * never transcript text (PII: spoken card numbers have appeared in calls).
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifyQuoSignature(rawBody, req.headers)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const type: string = event?.type ?? "";
  const data = event?.data?.object ?? {};
  const db = supabaseAdmin();

  if (type.startsWith("call.transcript")) {
    const callId = data.callId ?? data.id;
    if (!callId) return NextResponse.json({ ok: true, ignored: "no call id" });
    const utterances: Utterance[] = (data.dialogue ?? []).map((d: any) => ({
      // Quo dialogue entries carry userId only for workspace-side speakers.
      speaker: d.userId ? "rep" : "contact",
      text: d.content ?? "",
    }));
    const { error } = await db
      .from("call_events")
      .update({ classification: classifyTranscript(utterances) })
      .eq("quo_call_id", callId);
    if (error) {
      console.error("quo transcript update failed", error);
      return NextResponse.json({ error: "db error" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  if (type.startsWith("message.")) {
    if (!data.id) return NextResponse.json({ ok: true, ignored: "no message id" });
    // Outgoing: attribute to the sender. Incoming: no userId — attribute to
    // the owner of the receiving line (null on shared lines).
    let msgRepId: string | null = null;
    if (data.userId) {
      const { data: rep } = await db
        .from("reps")
        .select("id")
        .eq("quo_user_id", data.userId)
        .maybeSingle();
      msgRepId = rep?.id ?? null;
    } else if (data.phoneNumberId) {
      const { data: rep } = await db
        .from("reps")
        .select("id")
        .eq("quo_phone_number_id", data.phoneNumberId)
        .maybeSingle();
      msgRepId = rep?.id ?? null;
    }
    const { error } = await db.from("message_events").upsert(
      {
        quo_message_id: data.id,
        rep_id: msgRepId,
        phone_number_id: data.phoneNumberId ?? null,
        direction: data.direction ?? null,
        status: data.status ?? null,
        sent_at: data.createdAt ?? null,
      },
      { onConflict: "quo_message_id", ignoreDuplicates: false }
    );
    if (error) {
      console.error("quo message upsert failed", error);
      return NextResponse.json({ error: "db error" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  // Only lifecycle events carry a call object; recording/summary events
  // (dashboard webhook sends those too) have different payload shapes.
  const CALL_LIFECYCLE = ["call.ringing", "call.answered", "call.completed"];
  if (!CALL_LIFECYCLE.includes(type)) {
    return NextResponse.json({ ok: true, ignored: type });
  }

  const callId = data.id;
  if (!callId) return NextResponse.json({ ok: true, ignored: "no call id" });

  // Map the Quo user on the call to a rep; unmatched calls still land with
  // rep_id null so reconciliation can attribute them later.
  let repId: string | null = null;
  if (data.userId) {
    const { data: rep } = await db
      .from("reps")
      .select("id")
      .eq("quo_user_id", data.userId)
      .maybeSingle();
    repId = rep?.id ?? null;
  }

  const durationS =
    data.completedAt && data.answeredAt
      ? Math.max(0, Math.round((Date.parse(data.completedAt) - Date.parse(data.answeredAt)) / 1000))
      : null;

  const row: Record<string, unknown> = {
    quo_call_id: callId,
    rep_id: repId,
    direction: data.direction ?? null,
    status: data.status ?? type.replace("call.", ""),
    started_at: data.createdAt ?? null,
    answered_at: data.answeredAt ?? null,
    completed_at: data.completedAt ?? null,
    duration_s: durationS,
    raw: event,
  };
  // Later lifecycle events overwrite earlier ones (ringing → completed).
  const { error } = await db
    .from("call_events")
    .upsert(row, { onConflict: "quo_call_id", ignoreDuplicates: false });
  if (error) {
    console.error("quo call upsert failed", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
