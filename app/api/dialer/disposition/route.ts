import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { enqueuePdSync } from "@/lib/pd-sync";

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
    sprintId?: string;
    crmDealId?: string;
    next?: { type?: string; subject?: string; dueAt?: string };
    note?: string | null;
    quality?: { avg_loss_pct?: number; max_jitter_ms?: number; samples?: number; method?: string };
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
  if (body.sprintId && body.crmDealId) {
    await db
      .from("crm_sprint_items")
      .update({ disposition })
      .eq("sprint_id", body.sprintId)
      .eq("deal_id", body.crmDealId);
  }
  const windowStart = new Date(Date.parse(dialStartedAt) - 60_000).toISOString();
  const { data: call } = await db
    .from("call_events")
    .select("id")
    .contains("raw", { data: { object: { participants: [phone] } } })
    .gte("started_at", windowStart)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Resolve the CRM deal once — the note and next-step both hang off it.
  const resolveCrmDeal = async (): Promise<{ id: string; contact_id: string | null } | null> => {
    if (body.crmDealId) {
      const { data } = await db.from("crm_deals").select("id, contact_id").eq("id", body.crmDealId).maybeSingle();
      if (data) return data;
    }
    if (dealId) {
      const { data } = await db
        .from("crm_deals")
        .select("id, contact_id")
        .eq("pipedrive_deal_id", dealId)
        .maybeSingle();
      if (data) return data;
    }
    return null;
  };

  // Optional typed note — lands on the deal timeline + Pipedrive outbox.
  const saveNote = async () => {
    const text = body.note?.trim();
    if (!text) return;
    const deal = await resolveCrmDeal();
    if (deal) {
      await db.from("crm_activities").insert({
        deal_id: deal.id,
        contact_id: deal.contact_id,
        type: "note",
        subject: `📞 Call note (${disposition.replace("_", " ")})`,
        body: text,
        actor: user.email,
        occurred_at: new Date().toISOString(),
      });
    }
    if (dealId) {
      await enqueuePdSync(db, "note", { dealId, content: `📞 Call note — ${text}` });
    }
  };

  // The rep's next step, scheduled in the same gesture as the disposition.
  const scheduleNext = async () => {
    const n = body.next;
    if (!n?.dueAt || !["call", "task", "meeting", "email"].includes(n.type ?? "")) return;
    const deal = await resolveCrmDeal();
    if (!deal) return;
    const subject = n.subject?.trim() || `Follow up (${disposition})`;
    const { data: inserted } = await db
      .from("crm_activities")
      .insert({
        deal_id: deal.id,
        contact_id: deal.contact_id,
        type: n.type,
        subject,
        actor: user.email,
        due_at: n.dueAt,
        occurred_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (dealId && inserted) {
      await enqueuePdSync(db, "activity_create", {
        dealId,
        subject,
        type: n.type,
        dueAtIso: n.dueAt,
        crmActivityId: inserted.id,
      });
    }
  };

  if (call) {
    const update: Record<string, unknown> = { disposition, deal_id: dealId ?? null };
    if (body.quality) {
      const { data: row } = await db.from("call_events").select("raw").eq("id", call.id).maybeSingle();
      update.raw = { ...((row?.raw as any) ?? {}), client_quality: body.quality };
    }
    const { error } = await db.from("call_events").update(update).eq("id", call.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    // CRM row is saved — Pipedrive catches up via the outbox as budget allows.
    if (dealId) await enqueuePdSync(db, "disposition", { dealId, disposition, dialStartedAt });
    await saveNote();
    await scheduleNext();
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
    if (dealId) await enqueuePdSync(db, "disposition", { dealId, disposition, dialStartedAt });
    await saveNote();
    await scheduleNext();
    return NextResponse.json({ ok: true, attached: false, synthesized: true });
  }

  return NextResponse.json({ ok: true, attached: false }, { status: 202 });
}
