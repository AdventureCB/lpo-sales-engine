import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { envOptional } from "@/lib/env";
import {
  getDeal,
  getRecentPersonActivities,
  updateActivity,
  addDealNote,
} from "@/lib/pipedrive";

export const runtime = "nodejs";

const DISPOSITIONS = ["connected", "vm_dropped", "bad_number", "callback"] as const;
const DISPO_LABELS: Record<string, string> = {
  connected: "✅ Connected",
  vm_dropped: "🎙 Voicemail left",
  bad_number: "🚫 Bad number",
  callback: "📅 Callback scheduled",
};

/**
 * The Quo↔Pipedrive integration logs calls on the PERSON (it matches by
 * phone and can't know the deal). We know the deal — so link its freshly
 * created call activity to the deal and stamp the disposition into it. If
 * the integration's activity isn't there yet, leave a disposition note on
 * the deal so the attempt is visible regardless. Never creates duplicate
 * call activities.
 */
async function syncDispositionToPipedrive(
  dealId: number,
  disposition: string,
  dialStartedAt: string
): Promise<void> {
  const label = DISPO_LABELS[disposition] ?? disposition;
  const deal = await getDeal(dealId);
  const windowStart = Date.parse(dialStartedAt) - 2 * 60_000;

  if (deal.person_id) {
    const activities = await getRecentPersonActivities(deal.person_id);
    const callActivity = activities.find(
      (a) =>
        a.type === "call" &&
        a.add_time &&
        Date.parse(`${a.add_time.replace(" ", "T")}Z`) >= windowStart
    );
    if (callActivity) {
      const dispoLine = `Queue Runner disposition: ${label}`;
      await updateActivity(callActivity.id, {
        deal_id: dealId,
        note: callActivity.note ? `${callActivity.note}<br>${dispoLine}` : dispoLine,
      });
      return;
    }
  }
  await addDealNote(dealId, `📞 Dial attempt — ${label} (via Queue Runner)`);
}

/**
 * Attach the rep's disposition (and deal id) to the call row the webhook
 * created. If the webhook hasn't landed yet the client retries; after the
 * last retry it stores a placeholder row keyed on phone+time so no
 * disposition is ever lost.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    dealId?: number;
    phone?: string;
    disposition?: string;
    dialStartedAt?: string;
    final?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { dealId, phone, disposition, dialStartedAt } = body;
  if (!phone || !disposition || !dialStartedAt || !DISPOSITIONS.includes(disposition as any)) {
    return NextResponse.json({ error: "phone, disposition, dialStartedAt required" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const windowStart = new Date(Date.parse(dialStartedAt) - 60_000).toISOString();
  const { data: call } = await db
    .from("call_events")
    .select("id")
    .contains("raw", { data: { object: { participants: [phone] } } })
    .gte("started_at", windowStart)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (call) {
    const { error } = await db
      .from("call_events")
      .update({ disposition, deal_id: dealId ?? null })
      .eq("id", call.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    if (dealId && envOptional("PIPEDRIVE_API_TOKEN")) {
      try {
        await syncDispositionToPipedrive(dealId, disposition, dialStartedAt);
      } catch (e) {
        console.error("pipedrive disposition sync failed", e);
      }
    }
    return NextResponse.json({ ok: true, attached: true });
  }

  if (body.final) {
    // Webhook never arrived (or lags) — synthesize a row so the disposition
    // survives; nightly reconciliation will enrich it if the call appears.
    const { error } = await db.from("call_events").insert({
      quo_call_id: `manual-${phone}-${dialStartedAt}`,
      rep_id: user.repId,
      direction: "outgoing",
      status: "completed",
      started_at: dialStartedAt,
      disposition,
      deal_id: dealId ?? null,
    });
    if (error && !/duplicate/i.test(error.message)) {
      return NextResponse.json({ error: "db error" }, { status: 500 });
    }
    if (dealId && envOptional("PIPEDRIVE_API_TOKEN")) {
      try {
        await syncDispositionToPipedrive(dealId, disposition, dialStartedAt);
      } catch (e) {
        console.error("pipedrive disposition sync failed", e);
      }
    }
    return NextResponse.json({ ok: true, attached: false, synthesized: true });
  }

  return NextResponse.json({ ok: true, attached: false }, { status: 202 });
}
