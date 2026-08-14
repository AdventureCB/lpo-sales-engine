import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { envOptional } from "@/lib/env";

export const runtime = "nodejs";

/**
 * Telnyx call lifecycle → call_events (id-prefixed "tx:" so Quo rows never
 * collide). Ed25519 signature verification kicks in once TELNYX_PUBLIC_KEY
 * is set; during the trial it accepts unsigned.
 */
function verifySignature(raw: string, req: NextRequest): boolean {
  const pubKey = envOptional("TELNYX_PUBLIC_KEY");
  if (!pubKey) return true; // MVP trial mode
  const sig = req.headers.get("telnyx-signature-ed25519");
  const ts = req.headers.get("telnyx-timestamp");
  if (!sig || !ts) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(`${ts}|${raw}`),
      {
        key: crypto.createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(pubKey, "base64"),
          ]),
          format: "der",
          type: "spki",
        }),
      },
      Buffer.from(sig, "base64")
    );
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifySignature(raw, req)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const type = event?.data?.event_type ?? "";
  const p = event?.data?.payload ?? {};

  // ── Messaging events (SMS/MMS) ──────────────────────────────────────────
  // message.received = inbound; message.sent/finalized = delivery status.
  if (type.startsWith("message.")) {
    const mdb = supabaseAdmin();
    const from = p.from?.phone_number ?? null;
    const to0 = Array.isArray(p.to) ? p.to[0]?.phone_number ?? null : null;
    const status = Array.isArray(p.to) ? p.to[0]?.status ?? null : null;
    const inbound = p.direction === "inbound";
    const peerPhone = inbound ? from : to0;
    const ourNumber = inbound ? to0 : from;
    if (!p.id || !peerPhone) return NextResponse.json({ ok: true, ignored: "message: no id/peer" });

    // Attribute to the rep who owns the receiving/sending Telnyx number.
    let repId: string | null = null;
    if (ourNumber) {
      const { data: rep } = await mdb.from("reps").select("id").eq("telnyx_number", ourNumber).maybeSingle();
      repId = rep?.id ?? null;
    }

    await mdb.from("sms_messages").upsert(
      {
        provider: "telnyx",
        provider_message_id: p.id,
        rep_id: repId,
        direction: inbound ? "incoming" : "outgoing",
        status,
        phone_number_id: null,
        our_number: ourNumber,
        peer_phone: peerPhone,
        body: p.text ?? null,
        sent_at: p.received_at ?? p.sent_at ?? p.completed_at ?? new Date().toISOString(),
      },
      { onConflict: "provider,provider_message_id", ignoreDuplicates: false }
    );

    if (inbound && type === "message.received") {
      // Mirror carrier-level STOP/START into CRM consent (Telnyx auto-responds
      // + blocks at the network; we keep our record in sync).
      const kw = (p.text ?? "").trim().toUpperCase().replace(/[^A-Z]/g, "");
      if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(kw)) {
        await mdb.rpc("set_sms_consent_by_phone", { p_phone: from, p_consent: "opted_out" });
      } else if (["START", "UNSTOP", "YES"].includes(kw)) {
        await mdb.rpc("set_sms_consent_by_phone", { p_phone: from, p_consent: "opted_in" });
      }
      const { enqueueEvent } = await import("@/lib/automations");
      await enqueueEvent(mdb, "inbound_sms", { phone: from, provider: "telnyx", telnyx_message_id: p.id });
    }
    return NextResponse.json({ ok: true });
  }

  if (!type.startsWith("call.") || !p.call_session_id) {
    return NextResponse.json({ ok: true, ignored: type });
  }

  const db = supabaseAdmin();

  // Auto-record every answered call — the recording.saved event then feeds
  // the AI transcript. Never fail the webhook over recording problems.
  if (type === "call.answered" && p.call_control_id) {
    const { startRecording } = await import("@/lib/telnyx");
    startRecording(p.call_control_id).catch((e) => console.error("record_start", e));
  }

  // Recording saved → transcribe → attach to the call row + classify.
  if (type === "call.recording.saved") {
    const mp3 = p.recording_urls?.mp3 ?? p.public_recording_urls?.mp3;
    if (mp3) {
      try {
        const { transcribeRecording } = await import("@/lib/telnyx");
        const result = await transcribeRecording(mp3);
        if (result?.text?.trim()) {
          const { data: existing } = await db
            .from("call_events")
            .select("id, raw, duration_s, classification")
            .eq("quo_call_id", `tx:${p.call_session_id}`)
            .maybeSingle();
          if (existing) {
            // Speaker-attributed transcript (Deepgram) → the same turn-based
            // classifier the Quo path uses; plain text → talk-length heuristic.
            let classification = existing.classification;
            if (!classification && result.utterances) {
              const { classifyTranscript } = await import("@/lib/classify");
              classification = classifyTranscript(result.utterances);
            }
            if (!classification) {
              classification = (existing.duration_s ?? 0) >= 40 ? "conversation" : "screening";
            }
            await db
              .from("call_events")
              .update({
                raw: { ...(existing.raw ?? {}), transcript: result.text.trim() },
                classification,
              })
              .eq("id", existing.id);
          }
        }
      } catch (e) {
        console.error("transcription failed", e);
      }
    }
    return NextResponse.json({ ok: true });
  }

  // Cost + quality reports annotate the call row rather than acting as
  // lifecycle updates (they'd otherwise clobber the final status).
  if (type === "call.cost" || type.includes("rtcp") || type.includes("quality")) {
    const { data: existing } = await db
      .from("call_events")
      .select("id, raw")
      .eq("quo_call_id", `tx:${p.call_session_id}`)
      .maybeSingle();
    if (existing) {
      const raw = { ...(existing.raw ?? {}), [type === "call.cost" ? "cost" : "quality"]: p };
      await db.from("call_events").update({ raw }).eq("id", existing.id);
    }
    return NextResponse.json({ ok: true, annotated: type });
  }
  // Telnyx hangup events carry start/end but no answer_time — use start→end
  // as the duration and treat a normal clearing with real length as answered.
  const endT = p.end_time ?? p.hangup_time ?? null;
  const durationS =
    p.start_time && endT
      ? Math.max(0, Math.round((Date.parse(endT) - Date.parse(p.start_time)) / 1000))
      : null;
  const answered =
    p.answer_time ?? (p.hangup_cause === "normal_clearing" && (durationS ?? 0) > 5 ? p.start_time : null);
  // Preserve annotations other writers put on raw (client_quality from the
  // disposition, transcript, cost) — lifecycle upserts must merge, not replace.
  const { data: prior } = await db
    .from("call_events")
    .select("raw, answered_at")
    .eq("quo_call_id", `tx:${p.call_session_id}`)
    .maybeSingle();
  // Direction from the NUMBERS, not the leg label: inbound calls produce a
  // second leg toward the rep's browser that Telnyx marks "outgoing" even
  // though it's the same inbound call.
  const { normalizePhone } = await import("@/lib/identity");
  const ourNumbers = new Set<string>();
  const { data: repNums } = await db.from("reps").select("telnyx_number").not("telnyx_number", "is", null);
  for (const r of repNums ?? []) {
    const n = normalizePhone(r.telnyx_number);
    if (n) ourNumbers.add(n);
  }
  const { data: txState } = await db.from("crm_sync_state").select("value").eq("key", "telnyx").maybeSingle();
  const defaultNum = normalizePhone((txState?.value as any)?.callerNumber);
  if (defaultNum) ourNumbers.add(defaultNum);
  const fromN = normalizePhone(p.from);
  const toN = normalizePhone(p.to);
  const isIncoming = Boolean(toN && ourNumbers.has(toN) && (!fromN || !ourNumbers.has(fromN)));
  // Inbound answer state is exact (the call.answered event); the duration
  // heuristic is for outbound only — ring time would fake-answer missed calls.
  const answeredAt = isIncoming
    ? type === "call.answered"
      ? p.start_time ?? event?.data?.occurred_at ?? new Date().toISOString()
      : prior?.answered_at ?? null
    : answered;

  const row: Record<string, unknown> = {
    quo_call_id: `tx:${p.call_session_id}`,
    direction: isIncoming ? "incoming" : "outgoing",
    status: type.replace("call.", ""),
    started_at: p.start_time ?? event?.data?.occurred_at ?? null,
    answered_at: answeredAt,
    completed_at: endT,
    duration_s: durationS,
    raw: {
      ...((prior?.raw as any) ?? {}),
      telnyx: true,
      data: { object: { participants: [p.from, p.to].filter(Boolean) } },
      event,
    },
  };
  const { error } = await db
    .from("call_events")
    .upsert(row, { onConflict: "quo_call_id", ignoreDuplicates: false });
  if (error) {
    console.error("telnyx call upsert failed", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  // Inbound hangup: link the call to the caller's contact/deal + the rep
  // whose number was called; unanswered calls are classified missed.
  if (isIncoming && type === "call.hangup") {
    try {
      const { normalizePhone } = await import("@/lib/identity");
      const peer = normalizePhone(p.from);
      const update: Record<string, unknown> = {};
      if (!answeredAt) update.classification = "no_answer";
      if (p.to) {
        const { data: rep } = await db
          .from("reps")
          .select("id")
          .eq("telnyx_number", normalizePhone(p.to) ?? p.to)
          .maybeSingle();
        if (rep) update.rep_id = rep.id;
      }
      if (peer) {
        const { data: contact } = await db
          .from("crm_contacts")
          .select("id")
          .contains("phones", JSON.stringify([{ e164: peer }]))
          .maybeSingle();
        if (contact) {
          const { data: deal } = await db
            .from("crm_deals")
            .select("pipedrive_deal_id, status")
            .eq("contact_id", contact.id)
            .order("status", { ascending: true })
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (deal?.pipedrive_deal_id) update.deal_id = deal.pipedrive_deal_id;
        }
      }
      if (Object.keys(update).length > 0) {
        await db.from("call_events").update(update).eq("quo_call_id", `tx:${p.call_session_id}`);
      }
      // Drop the first-leg stub (initiated-only twin) so one inbound call
      // is one row.
      await db
        .from("call_events")
        .delete()
        .like("quo_call_id", "tx:%")
        .neq("quo_call_id", `tx:${p.call_session_id}`)
        .eq("status", "initiated")
        .is("answered_at", null)
        .eq("raw->event->data->payload->>from", p.from)
        .eq("raw->event->data->payload->>to", p.to)
        .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
    } catch (e) {
      console.error("inbound linking failed", e);
    }
  }
  return NextResponse.json({ ok: true });
}
