import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { listMessagesForNumber } from "@/lib/quo-api";

export const runtime = "nodejs";
export const maxDuration = 60;

const WINDOW_DAYS = 60;

/**
 * One-shot history import: pull recent Quo messages (with bodies) for every
 * active line so the Text UI opens with real conversations instead of only
 * webhook-era traffic. Idempotent — safe to re-run. Admin only.
 */
export async function POST() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  const db = supabaseAdmin();
  const { data: lines } = await db
    .from("quo_lines")
    .select("phone_number_id, label, phone_number")
    .eq("active", true);
  const { data: reps } = await db.from("reps").select("id, quo_user_id, quo_phone_number_id");
  const repByUser = new Map((reps ?? []).filter((r) => r.quo_user_id).map((r) => [r.quo_user_id, r.id]));
  const repByLine = new Map(
    (reps ?? []).filter((r) => r.quo_phone_number_id).map((r) => [r.quo_phone_number_id, r.id])
  );

  const createdAfter = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const counts: Record<string, number> = {};

  for (const line of lines ?? []) {
    let stored = 0;
    try {
      const msgs = await listMessagesForNumber({
        phoneNumberId: line.phone_number_id,
        createdAfter,
      });
      for (const m of msgs) {
        const msgTo = Array.isArray(m.to) ? m.to[0] : m.to;
        const peer = (m.direction === "incoming" ? m.from : msgTo) ?? null;
        const text = m.body ?? m.text ?? null;
        if (!peer) continue;
        const { error } = await db.from("sms_messages").upsert(
          {
            provider: "quo",
            provider_message_id: m.id,
            rep_id:
              (m.userId ? repByUser.get(m.userId) : null) ??
              repByLine.get(line.phone_number_id) ??
              null,
            direction: m.direction ?? null,
            status: m.status ?? null,
            phone_number_id: line.phone_number_id,
            our_number: (m.direction === "incoming" ? msgTo : m.from) ?? line.phone_number,
            peer_phone: peer,
            body: text,
            sent_at: m.createdAt ?? null,
          },
          { onConflict: "provider,provider_message_id", ignoreDuplicates: false }
        );
        if (!error) stored++;
      }
    } catch (e) {
      counts[`${line.label} (error)`] = 0;
      console.error(`backfill failed for ${line.label}`, e);
      continue;
    }
    counts[line.label] = stored;
  }

  return NextResponse.json({ ok: true, windowDays: WINDOW_DAYS, stored: counts });
}
