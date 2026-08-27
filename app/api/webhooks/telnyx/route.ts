import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { envOptional } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 60; // voicemail takeover waits out the ring window

const VM_DEFAULTS = {
  enabled: true,
  delay_s: 25,
  greeting:
    "Hi, you've reached Lone Peak Overland. Please leave your name, number, and a quick message after the tone.",
};

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

    // Inbound MMS: Telnyx's media URLs expire, so mirror each file into our
    // bucket (long-lived signed URL) — best-effort, original URL on failure.
    // Outbound events must NOT touch media (we already stored durable URLs at
    // send time; Telnyx's copies would clobber them with expiring ones).
    let inboundMedia: string[] | null = null;
    if (inbound && Array.isArray(p.media) && p.media.length) {
      const mirrored: (string | null)[] = await Promise.all(
        p.media.slice(0, 3).map(async (m: any) => {
          const src = m?.url;
          if (!src) return null;
          try {
            const res = await fetch(src);
            if (!res.ok) return src;
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length === 0 || buf.length > 8 * 1024 * 1024) return src;
            const ct = m.content_type ?? res.headers.get("content-type") ?? "image/jpeg";
            const ext = (ct.split("/")[1] ?? "jpg").replace("jpeg", "jpg").slice(0, 5);
            const path = `sms-in/${crypto.randomUUID()}.${ext}`;
            const { error } = await mdb.storage.from("comm-media").upload(path, buf, { contentType: ct });
            if (error) return src;
            const { data: signed } = await mdb.storage.from("comm-media").createSignedUrl(path, 10 * 365 * 24 * 3600);
            return signed?.signedUrl ?? src;
          } catch {
            return src;
          }
        })
      );
      const kept = mirrored.filter(Boolean) as string[];
      inboundMedia = kept.length > 0 ? kept : null;
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
        ...(inbound ? { media: inboundMedia } : {}),
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

  // Debug trail for multi-leg flows (transfer/VM) — cheap, call events only.
  void db
    .from("telnyx_event_log")
    .insert({
      event_type: type,
      session_id: p.call_session_id ?? null,
      leg_to: typeof p.to === "string" ? p.to : null,
      leg_from: typeof p.from === "string" ? p.from : null,
      client_state: p.client_state ?? null,
      payload: { ccid: p.call_control_id, leg_id: p.call_leg_id, direction: p.direction, state: p.state, cause: p.hangup_cause, connection_id: p.connection_id },
    })
    .then(({ error: e }) => e && console.error("event log", e));

  // The transfer's browser-bound leg (to sip:…) shares the A-leg's session id —
  // letting it through the lifecycle upsert clobbers the inbound row (direction,
  // completed_at) and kills the voicemail timer. Track it only in the log —
  // EXCEPT a fast failure (unregistered target → user_busy), which triggers one
  // fallback ring at the SHARED identity (token clients, e.g. kyle@ sessions).
  if (typeof p.to === "string" && !p.to.startsWith("+")) {
    // Internal legs (sip: URIs + bare SIP usernames Telnyx spawns while
    // bridging). Track the transfer leg's ccid so VM can kill the pending
    // ring; never let these legs touch the lifecycle row.
    const sessionKey = `tx:${p.call_session_id}`;
    if (type === "call.initiated" && p.to.startsWith("sip:") && p.call_control_id) {
      try {
        const { data: cur } = await db.from("call_events").select("id, raw").eq("quo_call_id", sessionKey).maybeSingle();
        if (cur) {
          await db
            .from("call_events")
            .update({ raw: { ...((cur.raw as any) ?? {}), b_ccid: p.call_control_id } })
            .eq("id", cur.id);
        }
      } catch (e) {
        console.error("b_ccid stash failed", e);
      }
    }
    // Fast failure (unregistered/busy client) → ONE fallback ring at the
    // shared identity. Never after a VM takeover, never on ring timeouts.
    if (type === "call.hangup" && p.hangup_cause === "user_busy" && p.to.startsWith("sip:")) {
      try {
        const { data: cur } = await db
          .from("call_events")
          .select("id, answered_at, completed_at, raw")
          .eq("quo_call_id", sessionKey)
          .maybeSingle();
        const craw = ((cur?.raw as any) ?? {}) as Record<string, unknown>;
        if (cur && !cur.answered_at && !cur.completed_at && !craw.vm && craw.a_ccid && !craw.ring2) {
          await db.from("call_events").update({ raw: { ...craw, ring2: true } }).eq("id", cur.id);
          const { transferCall, getSharedSipUsername } = await import("@/lib/telnyx");
          const shared = await getSharedSipUsername(db);
          if (shared && !p.to.includes(`${shared}@`)) {
            const caller = ((craw as any)?.data?.object?.participants ?? [])[0] ?? null;
            await transferCall(String(craw.a_ccid), `sip:${shared}@sip.telnyx.com`, { timeoutSecs: 55, clientState: "ring", from: typeof caller === "string" ? caller : null });
          }
        }
      } catch (e) {
        console.error("shared-ring fallback failed", e);
      }
    }
    return NextResponse.json({ ok: true, ignored: "internal-leg" });
  }

  // Voicemail legs are marked via client_state — they skip the normal
  // auto-record (greeting first, then a beeped recording).
  const { decodeClientState } = await import("@/lib/telnyx");
  const vmState = decodeClientState(p.client_state) === "vm";

  // Auto-record every answered call — the recording.saved event then feeds
  // the AI transcript. Never fail the webhook over recording problems.
  if (type === "call.answered" && p.call_control_id) {
    if (vmState) {
      // VM takeover answered: play the greeting (recorded audio when
      // configured, TTS otherwise); recording starts when the greeting ends.
      const { data: cfgRow } = await db.from("crm_sync_state").select("value").eq("key", "telnyx_vm").maybeSingle();
      const cfg = (cfgRow?.value as any) ?? {};
      const greeting = (cfg.greeting as string) || VM_DEFAULTS.greeting;
      const { speakCall, playbackCall } = await import("@/lib/telnyx");
      let played = false;
      if (cfg.greeting_mode === "audio" && cfg.greeting_audio_path) {
        try {
          const { data: signed } = await db.storage.from("vm-drops").createSignedUrl(cfg.greeting_audio_path, 3600);
          if (signed?.signedUrl) {
            await playbackCall(p.call_control_id, signed.signedUrl, "vm");
            played = true;
          }
        } catch (e) {
          console.error("vm audio greeting failed — falling back to TTS", e);
        }
      }
      if (!played) await speakCall(p.call_control_id, greeting, "vm").catch((e) => console.error("vm speak", e));
    } else {
      const { startRecording } = await import("@/lib/telnyx");
      await startRecording(p.call_control_id).catch((e) => console.error("record_start", e));
    }
  }

  // Recorded greeting finished → beep + record the message.
  if (type === "call.playback.ended") {
    if (vmState && p.call_control_id) {
      const { startRecording } = await import("@/lib/telnyx");
      // AWAITED: fire-and-forget here raced the serverless freeze — the
      // record-start request was killed with the lambda and voicemails were
      // silently never recorded (8/27).
      await startRecording(p.call_control_id, { beep: true, clientState: "vm" }).catch((e) => console.error("vm record", e));
    }
    return NextResponse.json({ ok: true }); // playback events aren't call lifecycle
  }

  // Greeting finished → beep + record the message.
  if (type === "call.speak.ended") {
    if (vmState && p.call_control_id) {
      const { startRecording } = await import("@/lib/telnyx");
      // AWAITED: fire-and-forget here raced the serverless freeze — the
      // record-start request was killed with the lambda and voicemails were
      // silently never recorded (8/27).
      await startRecording(p.call_control_id, { beep: true, clientState: "vm" }).catch((e) => console.error("vm record", e));
    }
    return NextResponse.json({ ok: true }); // speak events aren't call lifecycle
  }

  // Recording saved → transcribe → attach to the call row + classify.
  // Voicemail recordings additionally get the mp3 mirrored into our bucket
  // (Telnyx recording URLs expire) so the timeline can play them forever.
  if (type === "call.recording.saved") {
    const mp3 = p.recording_urls?.mp3 ?? p.public_recording_urls?.mp3;
    if (mp3) {
      try {
        const { data: existing } = await db
          .from("call_events")
          .select("id, raw, duration_s, classification")
          .eq("quo_call_id", `tx:${p.call_session_id}`)
          .maybeSingle();
        const isVm = vmState || Boolean((existing?.raw as any)?.vm);
        let vmMp3: string | null = null;
        if (isVm) {
          try {
            const res = await fetch(mp3);
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              if (buf.length > 0 && buf.length <= 20 * 1024 * 1024) {
                const path = `vm/${crypto.randomUUID()}.mp3`;
                const { error } = await db.storage.from("comm-media").upload(path, buf, { contentType: "audio/mpeg" });
                if (!error) {
                  const { data: signed } = await db.storage.from("comm-media").createSignedUrl(path, 10 * 365 * 24 * 3600);
                  vmMp3 = signed?.signedUrl ?? null;
                }
              }
            }
          } catch (e) {
            console.error("vm mirror failed", e);
          }
        }
        const { transcribeRecording } = await import("@/lib/telnyx");
        const result = await transcribeRecording(mp3, { voicemail: isVm }).catch(() => null);
        if (existing && (isVm || result?.text?.trim())) {
          let classification = existing.classification;
          if (isVm) {
            classification = "voicemail";
          } else if (!classification && result?.utterances) {
            // Speaker-attributed transcript (Deepgram) → the same turn-based
            // classifier the Quo path uses; plain text → talk-length heuristic.
            const { classifyTranscript } = await import("@/lib/classify");
            classification = classifyTranscript(result.utterances);
          }
          if (!classification) {
            classification = (existing.duration_s ?? 0) >= 40 ? "conversation" : "screening";
          }
          await db
            .from("call_events")
            .update({
              raw: {
                ...(existing.raw ?? {}),
                ...(result?.text?.trim() ? { transcript: result.text.trim() } : {}),
                ...(isVm ? { vm: true } : {}),
                ...(vmMp3 ? { vm_mp3: vmMp3 } : {}),
              },
              classification,
            })
            .eq("id", existing.id);
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
    .select("raw, answered_at, rep_id")
    .eq("quo_call_id", `tx:${p.call_session_id}`)
    .maybeSingle();
  // Direction from the NUMBERS, not the leg label: inbound calls produce a
  // second leg toward the rep's browser that Telnyx marks "outgoing" even
  // though it's the same inbound call.
  const { normalizePhone } = await import("@/lib/identity");
  const ourNumbers = new Set<string>();
  const repByNumber = new Map<string, string>();
  const { data: repNums } = await db.from("reps").select("id, telnyx_number").not("telnyx_number", "is", null);
  for (const r of repNums ?? []) {
    const n = normalizePhone(r.telnyx_number);
    if (n) {
      ourNumbers.add(n);
      repByNumber.set(n, r.id as string);
    }
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
    ? type === "call.answered" && !vmState
      ? p.start_time ?? event?.data?.occurred_at ?? new Date().toISOString()
      : prior?.answered_at ?? null
    : answered;

  // Attribute the call to the rep whose Telnyx number is on it — engagement
  // and inbound-talk tracking key on rep_id, and inbound calls have no
  // disposition step to stamp it later. Never clobber an existing value.
  const lifecycleRepId =
    (prior?.rep_id as string | null) ??
    (isIncoming ? (toN ? repByNumber.get(toN) ?? null : null) : fromN ? repByNumber.get(fromN) ?? null : null);

  const row: Record<string, unknown> = {
    quo_call_id: `tx:${p.call_session_id}`,
    rep_id: lifecycleRepId,
    direction: isIncoming ? "incoming" : "outgoing",
    status: type.replace("call.", ""),
    started_at: p.start_time ?? event?.data?.occurred_at ?? null,
    answered_at: answeredAt,
    completed_at: endT,
    duration_s: durationS,
    raw: {
      ...((prior?.raw as any) ?? {}),
      ...(vmState ? { vm: true } : {}),
      ...(isIncoming && type === "call.initiated" ? { a_ccid: p.call_control_id } : {}),
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

  // ── Ring the rep: numbers live on the Call Control app (so voicemail can
  // API-answer), which does NOT ring browsers by itself — transfer the leg to
  // the owning rep's SIP client. timeout 55s > VM window, so the VM timer
  // always wins the race and Telnyx never plays its own failure message.
  const inboundAppId = (txState?.value as any)?.inboundAppId ?? null;
  if (
    isIncoming &&
    type === "call.initiated" &&
    p.call_control_id &&
    inboundAppId &&
    String(p.connection_id) === String(inboundAppId)
  ) {
    try {
      let sipLogin: string | null = null;
      if (toN) {
        const { data: rep } = await db.from("reps").select("id").eq("telnyx_number", toN).maybeSingle();
        if (rep) {
          const { data: sip } = await db.from("crm_sync_state").select("value").eq("key", `telnyx_sip:${rep.id}`).maybeSingle();
          sipLogin = ((sip?.value as any)?.login as string) ?? null;
        }
      }
      // Busy guard: never ring a rep who's already on a live call — a second
      // INVITE into the browser softphone corrupts the active call (8/26:
      // Jackson's in-progress call dropped when an inbound rang). The caller
      // falls through to the VM timer below and the miss shows in the bell.
      let busy = false;
      if (sipLogin && toN) {
        const { data: live } = await db
          .from("call_events")
          .select("quo_call_id")
          .neq("quo_call_id", `tx:${p.call_session_id}`)
          .is("completed_at", null)
          .gte("started_at", new Date(Date.now() - 2 * 3600_000).toISOString())
          .contains("raw", { data: { object: { participants: [toN] } } })
          .limit(1);
        busy = Boolean(live?.length);
        if (busy) {
          await db.from("telnyx_event_log").insert({
            event_type: "ring.skip.busy",
            session_id: p.call_session_id ?? null,
            leg_from: p.from ?? null,
            leg_to: p.to ?? null,
            payload: { liveCall: live![0].quo_call_id },
          });
        }
      }
      if (sipLogin && !busy) {
        const { transferCall } = await import("@/lib/telnyx");
        await transferCall(p.call_control_id, `sip:${sipLogin}@sip.telnyx.com`, { timeoutSecs: 55, clientState: "ring", from: typeof p.from === "string" ? p.from : null });
      } else if (sipLogin) {
        // busy — VM timer takes the call
      } else {
        console.error(`no SIP client for inbound number ${toN} — call goes straight to voicemail timer`);
      }
    } catch (e) {
      console.error("inbound transfer failed", e);
    }
  }

  // ── Voicemail takeover: if nobody answers within the ring window, answer
  // the inbound leg ourselves (greeting → beep → record). Runs after the
  // webhook response (after()); the wait is idle time, not active CPU. The
  // answer command 422s harmlessly if the call already ended or was the
  // client-facing twin leg.
  if (isIncoming && type === "call.initiated" && p.call_control_id) {
    const ccid = p.call_control_id as string;
    const sessionKey = `tx:${p.call_session_id}`;
    after(async () => {
      try {
        const { data: cfgRow } = await db.from("crm_sync_state").select("value").eq("key", "telnyx_vm").maybeSingle();
        const cfg = { ...VM_DEFAULTS, ...((cfgRow?.value as any) ?? {}) };
        if (!cfg.enabled) return;
        const delay = Math.min(Math.max(Number(cfg.delay_s) || VM_DEFAULTS.delay_s, 5), 45);
        await new Promise((r) => setTimeout(r, delay * 1000));
        const { data: cur } = await db
          .from("call_events")
          .select("answered_at, completed_at, status, raw")
          .eq("quo_call_id", sessionKey)
          .maybeSingle();
        if (!cur || cur.answered_at || cur.completed_at || cur.status === "hangup") {
          await db.from("telnyx_event_log").insert({ event_type: "vm.timer.skip", session_id: sessionKey, payload: { cur } });
          return;
        }
        // Kill the still-ringing rep leg first — a live transfer leg delays
        // the greeting until its timeout and can drag the caller back into
        // ringing mid-voicemail.
        const bCcid = ((cur as any).raw as any)?.b_ccid as string | undefined;
        if (bCcid) {
          const { hangupCall } = await import("@/lib/telnyx");
          await hangupCall(bCcid).catch(() => {});
        }
        const { answerCall } = await import("@/lib/telnyx");
        try {
          await answerCall(ccid, "vm");
          await db.from("telnyx_event_log").insert({ event_type: "vm.answer.ok", session_id: sessionKey, payload: { ccid } });
        } catch (e) {
          await db.from("telnyx_event_log").insert({
            event_type: "vm.answer.err",
            session_id: sessionKey,
            payload: { ccid, error: e instanceof Error ? e.message : String(e) },
          });
          throw e;
        }
      } catch (e) {
        // Expected for twin legs / raced hangups — log-only.
        console.error("vm takeover skipped:", e instanceof Error ? e.message : e);
      }
    });
  }

  // Inbound hangup: link the call to the caller's contact/deal + the rep
  // whose number was called; unanswered calls are classified missed.
  if (isIncoming && type === "call.hangup") {
    try {
      const { normalizePhone } = await import("@/lib/identity");
      const peer = normalizePhone(p.from);
      const update: Record<string, unknown> = {};
      const wasVm = vmState || Boolean((prior?.raw as any)?.vm);
      if (!answeredAt) update.classification = wasVm ? "voicemail" : "no_answer";
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
            .select("id, pipedrive_deal_id, status")
            .eq("contact_id", contact.id)
            .order("status", { ascending: true })
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          // Native-first: link by crm id always; PD id rides along when it exists.
          if (deal) {
            update.crm_deal_id = deal.id;
            if (deal.pipedrive_deal_id) update.deal_id = deal.pipedrive_deal_id;
          }
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
