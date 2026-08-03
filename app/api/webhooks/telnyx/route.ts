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
  if (!type.startsWith("call.") || !p.call_session_id) {
    return NextResponse.json({ ok: true, ignored: type });
  }

  const db = supabaseAdmin();

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
  const durationS =
    p.answer_time && (p.end_time || p.hangup_time)
      ? Math.max(0, Math.round((Date.parse(p.end_time ?? p.hangup_time) - Date.parse(p.answer_time)) / 1000))
      : null;
  const row: Record<string, unknown> = {
    quo_call_id: `tx:${p.call_session_id}`,
    direction: p.direction === "incoming" ? "incoming" : "outgoing",
    status: type.replace("call.", ""),
    started_at: p.start_time ?? event?.data?.occurred_at ?? null,
    answered_at: p.answer_time ?? null,
    completed_at: p.end_time ?? p.hangup_time ?? null,
    duration_s: durationS,
    raw: { telnyx: true, data: { object: { participants: [p.from, p.to].filter(Boolean) } }, event },
  };
  const { error } = await db
    .from("call_events")
    .upsert(row, { onConflict: "quo_call_id", ignoreDuplicates: false });
  if (error) {
    console.error("telnyx call upsert failed", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
