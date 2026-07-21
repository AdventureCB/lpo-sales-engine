import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

const DISPOSITIONS = ["connected", "vm_dropped", "bad_number", "callback"] as const;

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
    return NextResponse.json({ ok: true, attached: false, synthesized: true });
  }

  return NextResponse.json({ ok: true, attached: false }, { status: 202 });
}
