import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { sendDue } from "@/lib/campaigns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Outbox — campaign sends awaiting approval (and recent history).
 *   GET ?scope=mine|team|rep:<email>   (team/rep = admin)
 *   POST {id, action: approve|skip|reject, subject?, body?, sendNow?}
 *   POST {id, action: stop}            → stop the whole enrollment
 * Approver = the deal owner (the sender) or an admin.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const isAdmin = user.role === "admin";
  const scope = new URL(req.url).searchParams.get("scope") ?? "mine";
  let q = db
    .from("campaign_sends")
    .select("id, enrollment_id, campaign_id, step_position, deal_id, contact_id, owner_email, channel, to_address, subject, body, generated_by, ai_meta, status, scheduled_for, approved_by, approved_at, edited, sent_at, error, created_at, campaigns ( name, mode ), crm_deals ( title, truck_model, crm_stages ( name ) ), crm_contacts ( name )")
    .in("status", ["draft", "approved", "sent", "failed", "skipped"])
    .gt("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString())
    .order("status")
    .order("scheduled_for")
    .limit(300);
  if (!isAdmin || scope === "mine") q = q.eq("owner_email", user.email);
  else if (scope.startsWith("rep:")) q = q.eq("owner_email", scope.slice(4));
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const enrollmentIds = [...new Set((data ?? []).map((s: any) => s.enrollment_id))];
  const { data: enrs } = enrollmentIds.length
    ? await db.from("campaign_enrollments").select("id, current_step, hold_reason, status").in("id", enrollmentIds)
    : { data: [] as any[] };
  const enrBy = new Map((enrs ?? []).map((e: any) => [e.id, e]));
  let reps: { email: string; name: string }[] = [];
  if (isAdmin) {
    const { data: r } = await db.from("reps").select("email, name").eq("active", true).not("email", "is", null).order("sort_order");
    reps = (r ?? []) as any[];
  }
  return NextResponse.json({
    isAdmin,
    me: user.email,
    scope: isAdmin ? scope : "mine",
    reps,
    items: (data ?? []).map((s: any) => ({
      id: s.id, enrollmentId: s.enrollment_id, campaignId: s.campaign_id, campaign: s.campaigns?.name ?? "", mode: s.campaigns?.mode ?? "macro",
      step: s.step_position + 1, dealId: s.deal_id, dealTitle: s.crm_deals?.title ?? null, stage: s.crm_deals?.crm_stages?.name ?? null, truck: s.crm_deals?.truck_model ?? null,
      contactName: s.crm_contacts?.name ?? null, owner: s.owner_email, channel: s.channel, to: s.to_address, subject: s.subject, body: s.body,
      generatedBy: s.generated_by, aiMeta: s.ai_meta, status: s.status, scheduledFor: s.scheduled_for, approvedBy: s.approved_by, approvedAt: s.approved_at,
      edited: s.edited, sentAt: s.sent_at, error: s.error, createdAt: s.created_at, enrollment: enrBy.get(s.enrollment_id) ?? null,
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { id?: string; action?: string; subject?: string; body?: string; sendNow?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.id || !body.action) return NextResponse.json({ error: "id and action required" }, { status: 400 });
  const db = supabaseAdmin();
  const { data: s } = await db.from("campaign_sends").select("*").eq("id", body.id).maybeSingle();
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (user.role !== "admin" && s.owner_email !== user.email) return NextResponse.json({ error: "Only the deal owner or an admin can approve this." }, { status: 403 });
  const now = new Date().toISOString();

  if (body.action === "stop") {
    await db.from("campaign_enrollments").update({ status: "exited", exited_at: now, exit_reason: `stopped by ${user.email.split("@")[0]}` }).eq("id", s.enrollment_id);
    await db.from("campaign_sends").update({ status: "skipped", error: "campaign stopped" }).eq("enrollment_id", s.enrollment_id).in("status", ["draft", "approved"]);
    await db.from("crm_activities").insert({ deal_id: s.deal_id, contact_id: s.contact_id, type: "system", subject: "📣 Campaign stopped from the Outbox", actor: user.email, occurred_at: now, meta: { campaign_id: s.campaign_id } });
    return NextResponse.json({ ok: true });
  }
  if (!["draft", "approved", "failed"].includes(s.status)) return NextResponse.json({ error: `already ${s.status}` }, { status: 409 });

  if (body.action === "skip" || body.action === "reject") {
    await db.from("campaign_sends").update({ status: body.action === "skip" ? "skipped" : "rejected", approved_by: user.email, approved_at: now }).eq("id", s.id);
    if (body.action === "reject" && s.generated_by === "ai") {
      // Learning signal: a rejected AI draft is a 👎 for the critic.
      await db.from("draft_events").insert({
        deal_id: s.deal_id, kind: s.channel === "sms" ? "sms" : "email", theme_key: `campaign:${s.campaign_id}`, direction: `step ${s.step_position + 1}`, rep: s.owner_email,
        draft_body: String(s.body).slice(0, 4000), generated_at: s.created_at, thumbs: "down", thumbs_note: body.body?.trim() ? String(body.body).slice(0, 300) : "rejected in Outbox",
      }).then(() => {}, () => {});
    }
    if (body.action === "skip") {
      // Skip = move on to the next step without sending this one.
      const { data: next } = await db.from("campaign_steps").select("delay_hours").eq("campaign_id", s.campaign_id).eq("position", s.step_position + 1).maybeSingle();
      await db.from("campaign_enrollments").update({ current_step: s.step_position + 1, next_step_at: next ? new Date(Date.now() + next.delay_hours * 3_600_000).toISOString() : now, hold_reason: null }).eq("id", s.enrollment_id);
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "approve") {
    const subject = body.subject != null ? String(body.subject).trim().slice(0, 200) : s.subject;
    const text = body.body != null ? String(body.body).trim().slice(0, 20_000) : s.body;
    if (!text || (s.channel === "email" && !subject)) return NextResponse.json({ error: "subject and body required" }, { status: 400 });
    const edited = subject !== s.subject || text !== s.body;
    const scheduledFor = body.sendNow || !s.scheduled_for || Date.parse(s.scheduled_for) < Date.now() ? now : s.scheduled_for;
    await db
      .from("campaign_sends")
      .update({ status: "approved", subject, body: text, edited: edited || s.edited, original_body: s.original_body ?? (edited ? s.body : null), approved_by: user.email, approved_at: now, scheduled_for: scheduledFor, error: null })
      .eq("id", s.id);
    if (body.sendNow) {
      const r = await sendDue(db, { limit: 5 });
      return NextResponse.json({ ok: true, ...r });
    }
    return NextResponse.json({ ok: true, scheduledFor });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
