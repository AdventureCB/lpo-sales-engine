import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { envOptional } from "@/lib/env";
import { updateDealStage, addDealNote, createActivity, updateActivity } from "@/lib/pipedrive";
import { enqueuePdSync } from "@/lib/pd-sync";
import { extractMentions, withMentions } from "@/lib/mentions";
import { resolveReprospect } from "@/lib/reprospect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deal detail: full record + timeline (native activities ∪ captured calls). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  const pdId = params.get("pdId"); // dialer leads know the Pipedrive id
  if (!id && !pdId) return NextResponse.json({ error: "id or pdId required" }, { status: 400 });

  const db = supabaseAdmin();
  let q = db
    .from("crm_deals")
    .select(
      "*, crm_stages ( id, name, pipeline_id, crm_pipelines ( id, name ) ), crm_contacts ( id, name, emails, phones, org_name, attribution, sms_consent, sms_consent_at, sms_consent_source )"
    );
  q = id ? q.eq("id", id) : q.eq("pipedrive_deal_id", Number(pdId));
  const { data: deal, error } = await q.maybeSingle();
  if (error || !deal) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Quo logs calls/notes on the person, not the deal — pull the contact's
  // activities into the deal timeline too, or most history is invisible.
  const activityFilter = deal.contact_id
    ? `deal_id.eq.${deal.id},contact_id.eq.${deal.contact_id}`
    : `deal_id.eq.${deal.id}`;
  // Inbound texts live in sms_messages (webhook-fed), keyed by phone — merge
  // them into the timeline so replies show on the deal page. Outbound texts
  // already land as crm_activities rows at send time.
  const timelinePhones = ((deal.crm_contacts?.phones as any[]) ?? [])
    .map((p) => p.e164 ?? p.value)
    .filter(Boolean);
  const [activities, calls, stages, sprints, dealSprints, owners, inboundSms] = await Promise.all([
    db
      .from("crm_activities")
      .select("id, type, subject, body, actor, due_at, done_at, occurred_at, deal_id, meta")
      .or(activityFilter)
      .order("occurred_at", { ascending: false })
      .limit(150),
    deal.pipedrive_deal_id
      ? db
          .from("call_events")
          .select("quo_call_id, direction, started_at, duration_s, classification, disposition, transcript:raw->>transcript, quality:raw->client_quality, vm_mp3:raw->>vm_mp3")
          .eq("deal_id", deal.pipedrive_deal_id)
          .order("started_at", { ascending: false })
          .limit(25)
      : Promise.resolve({ data: [] }),
    db
      .from("crm_stages")
      .select("id, name, pipeline_id, crm_pipelines ( name )")
      .order("sort_order"),
    db
      .from("crm_sprints")
      .select("id, name, owner")
      .eq("status", "active")
      .order("created_at", { ascending: false }),
    db.from("crm_sprint_items").select("sprint_id").eq("deal_id", deal.id),
    db.from("app_users").select("email, role").order("email"),
    timelinePhones.length
      ? db
          .from("sms_messages")
          .select("id, body, media, sent_at, our_number")
          .eq("direction", "incoming")
          .in("peer_phone", timelinePhones)
          .order("sent_at", { ascending: false })
          .limit(30)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const [{ data: sources }, { data: pipelines }] = await Promise.all([
    db.from("deal_sources").select("id, name").order("sort_order").order("name"),
    db.from("crm_pipelines").select("id, name").order("sort_order").order("name"),
  ]);

  const timeline = [
    ...(activities.data ?? []).map((a) => ({
      id: a.id,
      kind: a.type,
      at: a.occurred_at,
      title: (a.subject ?? a.type) + (a.deal_id === deal.id ? "" : " · (contact)"),
      body: a.body,
      media: (a as any).meta?.media ?? null,
      actor: a.actor,
      done: Boolean(a.done_at),
      due: a.due_at,
    })),
    ...((calls as any).data ?? []).map((c: any) => ({
      kind: "call",
      at: c.started_at,
      title:
        c.classification === "voicemail"
          ? "📼 Voicemail"
          : c.direction === "incoming" && c.classification === "no_answer"
            ? "📵 Missed call"
            : `${c.direction === "incoming" ? "Inbound" : "Outbound"} call · ${c.classification ?? "—"}${c.disposition ? ` · ${c.disposition}` : ""}`,
      body: [
        c.duration_s ? `${Math.round(c.duration_s / 60)}m ${c.duration_s % 60}s` : null,
        c.quality
          ? `📶 ${c.quality.avg_loss_pct ?? 0}% loss · ${c.quality.max_jitter_ms ?? 0}ms jitter`
          : null,
        c.transcript ? `🎙 ${c.transcript}` : null,
      ]
        .filter(Boolean)
        .join(" — "),
      audio: c.vm_mp3 ?? null,
      actor: null,
      done: true,
      due: null,
    })),
    ...((inboundSms as any).data ?? []).map((m: any) => ({
      id: `sms-in-${m.id}`,
      kind: "sms",
      at: m.sent_at,
      title: "💬 Text received",
      body: m.body,
      media: m.media ?? null,
      actor: null,
      done: true,
      due: null,
    })),
  ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  // Call counters: every call tied to this deal or any of the contact's
  // numbers — dials, talk, answer rate.
  const contactPhones = ((deal.crm_contacts?.phones as any[]) ?? [])
    .map((p) => p.e164 ?? p.value)
    .filter(Boolean);
  let callStats: { dials: number; answered: number; talkS: number; inbound: number } | null = null;
  if (contactPhones.length > 0 || deal.pipedrive_deal_id) {
    const { data: cs } = await db.rpc("deal_call_stats", {
      p_phones: contactPhones,
      p_deal_id: deal.pipedrive_deal_id ?? null,
    });
    const row = Array.isArray(cs) ? cs[0] : cs;
    if (row) {
      callStats = {
        dials: Number(row.dials),
        answered: Number(row.answered),
        talkS: Number(row.talk_s),
        inbound: Number(row.inbound),
      };
    }
  }

  // Ad attribution chip: contact's source/campaign + estimated channel CPL.
  let adInfo: { source: string | null; campaign: string | null; channel: string | null; leadCostCents: number | null } | null = null;
  let adJourney: unknown = null;
  try {
    const { contactAdInfo, cachedLeadCost, computeAdJourney, campaignStats } = await import("@/lib/lead-cost");
    const info = contactAdInfo(deal.crm_contacts?.attribution);
    if (info.source || info.channel) {
      const report = await cachedLeadCost(db, 30);
      const cpl = info.channel ? report.channels.find((c) => c.channel === info.channel)?.cplCents ?? null : null;
      // Resolve raw campaign ids to names where the platform API knows them.
      if (info.channel && info.campaign) {
        const camp = (await campaignStats(db, 400)).get(`${info.channel}|${info.campaign}`);
        if (camp?.name) info.campaign = camp.name;
      }
      adInfo = { ...info, leadCostCents: cpl };
    }
    const contactEmails = ((deal.crm_contacts?.emails as any[]) ?? []).map((e) => e.value).filter(Boolean);
    adJourney = await computeAdJourney(db, contactEmails, deal.crm_contacts?.attribution);
  } catch {}

  // AI buyer profile (if one has been built for this deal).
  const { data: aiProfile } = await db.from("deal_profiles").select("*").eq("deal_id", deal.id).maybeSingle();

  // Should the client auto-build/refresh on open? Enabled + eligible + new
  // activity since the last run. Loose by design — the engine re-checks
  // debounce/budget/require-transcript and no-ops (free) if nothing's due.
  let aiProfileStale = false;
  try {
    const { loadAiConfig } = await import("@/lib/ai-profiler");
    const cfg = await loadAiConfig(db);
    if (cfg.enabled && deal.status === "open") {
      const pipeName = (deal.crm_stages as any)?.crm_pipelines?.name ?? "";
      const scopeOk = cfg.pipelines.length === 0 || cfg.pipelines.includes(pipeName);
      const valueOk = cfg.min_value_cents == null || (deal.value_cents ?? 0) >= cfg.min_value_cents;
      const activeOk =
        cfg.active_days <= 0 ||
        (deal.last_activity_at != null &&
          deal.last_activity_at >= new Date(Date.now() - cfg.active_days * 86_400_000).toISOString());
      const processedAt = (aiProfile?.watermark as any)?.processed_at ?? null;
      const hasNew = !aiProfile || (deal.last_activity_at != null && deal.last_activity_at > processedAt);
      aiProfileStale = scopeOk && valueOk && activeOk && hasNew;
    }
  } catch {}

  return NextResponse.json({
    deal,
    timeline,
    callStats,
    adInfo,
    adJourney,
    aiProfile: aiProfile ?? null,
    aiProfileStale,
    sources: sources ?? [],
    pipelines: pipelines ?? [],
    stages: stages.data ?? [],
    sprints: sprints.data ?? [],
    dealSprintIds: (dealSprints.data ?? []).map((s) => s.sprint_id),
    sprintOwners: (owners.data ?? []).map((u) => u.email),
  });
}

/**
 * Edit a deal (stage move / status / add note). Write-through: the local
 * mirror updates immediately, and the same change is pushed to Pipedrive so
 * nothing diverges before cutover. If Pipedrive is unavailable (budget), the
 * local edit stands and the write-through error is reported.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    id?: string;
    title?: string;
    valueDollars?: number | null;
    stageId?: string;
    status?: string;
    lostReason?: string;
    note?: string;
    noteTitle?: string;
    ownerPipedriveId?: number;
    activity?: { type: string; subject: string; dueAt?: string | null };
    logActivity?: { type: string; subject: string; body?: string; occurredAt?: string };
    sourceId?: string | null;
    truckModel?: string | null;
    interests?: string[];
    completeActivityId?: string;
    editActivity?: { activityId: string; subject?: string; type?: string; dueAt?: string | null; body?: string | null };
    deleteActivityId?: string;
    sprint?: { sprintId?: string; name?: string; owner?: string };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: deal } = await db
    .from("crm_deals")
    .select("id, pipedrive_deal_id, contact_id")
    .eq("id", body.id)
    .maybeSingle();
  if (!deal) return NextResponse.json({ error: "not found" }, { status: 404 });

  let writeThroughError: string | null = null;
  const canWriteThrough = Boolean(envOptional("PIPEDRIVE_API_TOKEN")) && deal.pipedrive_deal_id;

  // Log something that already happened (manual timeline entry). Lands as a
  // completed activity — bumps last_activity_at and shows on the timeline.
  if (body.logActivity) {
    const { type, subject, body: note, occurredAt } = body.logActivity;
    if (!["call", "meeting", "email", "sms", "task", "note"].includes(type) || !subject?.trim()) {
      return NextResponse.json({ error: "activity type/subject invalid" }, { status: 400 });
    }
    const at = occurredAt || new Date().toISOString();
    const { data: inserted, error } = await db
      .from("crm_activities")
      .insert({
        deal_id: deal.id,
        contact_id: deal.contact_id,
        type,
        subject: subject.trim(),
        body: note?.trim() || null,
        actor: user.email,
        occurred_at: at,
        done_at: at, // it already happened
        meta: withMentions(null, await extractMentions(db, note)) ?? null,
      })
      .select("id")
      .single();
    if (error || !inserted) return NextResponse.json({ error: "db error" }, { status: 500 });
    // Pipedrive gets a completed activity (skip 'note' — no matching PD type).
    if (canWriteThrough && type !== "note") {
      await enqueuePdSync(db, "activity_create", {
        dealId: deal.pipedrive_deal_id,
        subject: subject.trim(),
        type: type === "sms" ? "task" : type,
        dueAtIso: at,
        done: true,
        crmActivityId: inserted.id,
      });
    }
  }

  // Schedule an activity (call / task / meeting / email) with a due time.
  // CRM row first; Pipedrive immediately if possible, else via the outbox.
  if (body.activity) {
    const { type, subject, dueAt } = body.activity;
    if (!["call", "task", "meeting", "email"].includes(type) || !subject?.trim()) {
      return NextResponse.json({ error: "activity type/subject invalid" }, { status: 400 });
    }
    const { data: inserted, error } = await db
      .from("crm_activities")
      .insert({
        deal_id: deal.id,
        contact_id: deal.contact_id,
        type,
        subject: subject.trim(),
        actor: user.email,
        due_at: dueAt ?? null,
        occurred_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !inserted) return NextResponse.json({ error: "db error" }, { status: 500 });
    if (canWriteThrough) {
      try {
        const pdId = await createActivity({
          dealId: deal.pipedrive_deal_id!,
          subject: subject.trim(),
          type,
          dueAtIso: dueAt ?? null,
        });
        if (pdId) {
          await db.from("crm_activities").update({ pipedrive_activity_id: pdId }).eq("id", inserted.id);
        }
      } catch {
        await enqueuePdSync(db, "activity_create", {
          dealId: deal.pipedrive_deal_id,
          subject: subject.trim(),
          type,
          dueAtIso: dueAt ?? null,
          crmActivityId: inserted.id,
        });
        writeThroughError = "Pipedrive busy — queued, will sync automatically";
      }
    }
    // Scheduling a future activity on a reprospecting-pool deal reclaims it.
    if (dueAt) {
      await resolveReprospect(db, {
        crmDealId: deal.id,
        repEmail: user.email,
        repPipedriveId: user.pipedriveUserId,
        event: "scheduled",
      });
    }
  }

  // Mark a scheduled activity done (write-through to Pipedrive when linked).
  if (body.completeActivityId) {
    const { data: act } = await db
      .from("crm_activities")
      .select("id, pipedrive_activity_id")
      .eq("id", body.completeActivityId)
      .maybeSingle();
    if (!act) return NextResponse.json({ error: "activity not found" }, { status: 404 });
    const { error } = await db
      .from("crm_activities")
      .update({ done_at: new Date().toISOString() })
      .eq("id", act.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    if (act.pipedrive_activity_id && canWriteThrough) {
      try {
        await updateActivity(act.pipedrive_activity_id, { done: 1 });
      } catch {
        await enqueuePdSync(db, "activity_done", { pipedriveActivityId: act.pipedrive_activity_id });
        writeThroughError = "Pipedrive busy — queued, will sync automatically";
      }
    }
  }

  // Rename the deal. CRM-first; title written through to Pipedrive.
  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
    await db.from("crm_deals").update({ title, updated_at: new Date().toISOString() }).eq("id", deal.id);
    if (canWriteThrough) {
      try {
        await updateDealStage(deal.pipedrive_deal_id!, { title });
      } catch {
        await enqueuePdSync(db, "deal_update", { dealId: deal.pipedrive_deal_id, fields: { title } });
        writeThroughError = "Pipedrive busy — queued, will sync automatically";
      }
    }
  }

  // Deal value. CRM-first; written through to Pipedrive.
  if (body.valueDollars !== undefined) {
    const cents = body.valueDollars == null ? null : Math.round(body.valueDollars * 100);
    if (cents != null && (!Number.isFinite(cents) || cents < 0)) {
      return NextResponse.json({ error: "invalid value" }, { status: 400 });
    }
    await db.from("crm_deals").update({ value_cents: cents, updated_at: new Date().toISOString() }).eq("id", deal.id);
    if (canWriteThrough) {
      try {
        await updateDealStage(deal.pipedrive_deal_id!, { value: body.valueDollars ?? 0 });
      } catch {
        await enqueuePdSync(db, "deal_update", { dealId: deal.pipedrive_deal_id, fields: { value: body.valueDollars ?? 0 } });
        writeThroughError = "Pipedrive busy — queued, will sync automatically";
      }
    }
  }

  // Primary interests — CRM-native (no Pipedrive field).
  if (body.interests !== undefined) {
    const clean = [...new Set((body.interests ?? []).map((s) => s.trim()).filter(Boolean))];
    const { error } = await db.from("crm_deals").update({ interests: clean }).eq("id", deal.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  // Truck model — manual entry from conversation. CRM-native.
  if (body.truckModel !== undefined) {
    const { error } = await db
      .from("crm_deals")
      .update({ truck_model: body.truckModel?.trim() || null })
      .eq("id", deal.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  // Source assignment — CRM-native, no Pipedrive write-through (we own it).
  if (body.sourceId !== undefined) {
    const { error } = await db
      .from("crm_deals")
      .update({ source_id: body.sourceId || null })
      .eq("id", deal.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  // Reschedule / retitle / retype a scheduled activity.
  if (body.editActivity?.activityId) {
    const e = body.editActivity;
    const { data: act } = await db
      .from("crm_activities")
      .select("id, pipedrive_activity_id, meta")
      .eq("id", e.activityId)
      .maybeSingle();
    if (!act) return NextResponse.json({ error: "activity not found" }, { status: 404 });
    const patch: Record<string, unknown> = {};
    if (e.subject?.trim()) patch.subject = e.subject.trim();
    if (e.type && ["call", "sms", "email", "task", "note", "meeting"].includes(e.type)) patch.type = e.type;
    if (e.dueAt !== undefined) patch.due_at = e.dueAt;
    if (e.body !== undefined) {
      patch.body = e.body?.trim() || null;
      // Re-extract mentions so edits can add (or remove) tags.
      const mentions = await extractMentions(db, e.body);
      patch.meta = { ...((act.meta as Record<string, unknown>) ?? {}), mentions };
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: "nothing to change" }, { status: 400 });
    const { error } = await db.from("crm_activities").update(patch).eq("id", act.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    if (act.pipedrive_activity_id) {
      const fields: Record<string, unknown> = {};
      if (patch.subject) fields.subject = patch.subject;
      if (patch.type) fields.type = patch.type;
      if (e.dueAt) {
        const d = new Date(e.dueAt);
        fields.due_date = d.toISOString().slice(0, 10);
        fields.due_time = d.toISOString().slice(11, 16);
      }
      await enqueuePdSync(db, "activity_edit", {
        pipedriveActivityId: act.pipedrive_activity_id,
        fields,
      });
    }
  }

  // Remove a scheduled activity outright.
  if (body.deleteActivityId) {
    const { data: act } = await db
      .from("crm_activities")
      .select("id, pipedrive_activity_id")
      .eq("id", body.deleteActivityId)
      .maybeSingle();
    if (!act) return NextResponse.json({ error: "activity not found" }, { status: 404 });
    const { error } = await db.from("crm_activities").delete().eq("id", act.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    if (act.pipedrive_activity_id) {
      await enqueuePdSync(db, "activity_delete", { pipedriveActivityId: act.pipedrive_activity_id });
    }
  }

  // Add this deal to a call sprint — existing, or created on the spot.
  if (body.sprint) {
    let sprintId = body.sprint.sprintId ?? null;
    if (!sprintId && body.sprint.name?.trim() && body.sprint.owner?.trim()) {
      const { data: created, error } = await db
        .from("crm_sprints")
        .insert({ name: body.sprint.name.trim(), owner: body.sprint.owner.trim() })
        .select("id")
        .single();
      if (error || !created) return NextResponse.json({ error: "db error" }, { status: 500 });
      sprintId = created.id;
    }
    if (!sprintId) return NextResponse.json({ error: "sprintId or name+owner required" }, { status: 400 });
    const { count } = await db
      .from("crm_sprint_items")
      .select("*", { count: "exact", head: true })
      .eq("sprint_id", sprintId);
    const { error } = await db
      .from("crm_sprint_items")
      .upsert(
        { sprint_id: sprintId, deal_id: deal.id, position: count ?? 0 },
        { onConflict: "sprint_id,deal_id", ignoreDuplicates: true }
      );
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  if (body.note?.trim()) {
    const title = body.noteTitle?.trim();
    const { error } = await db.from("crm_activities").insert({
      deal_id: deal.id,
      type: "note",
      subject: title ? `📝 ${title}` : null,
      body: body.note.trim(),
      actor: user.email,
      meta: withMentions(null, await extractMentions(db, body.note)) ?? null,
    });
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    if (canWriteThrough) {
      try {
        await addDealNote(deal.pipedrive_deal_id!, body.note.trim());
      } catch {
        await enqueuePdSync(db, "note", { dealId: deal.pipedrive_deal_id, content: body.note.trim() });
        writeThroughError = "Pipedrive busy — queued, will sync automatically";
      }
    }
  }

  if (body.ownerPipedriveId) {
    const { error } = await db
      .from("crm_deals")
      .update({ owner_pipedrive_id: body.ownerPipedriveId, updated_at: new Date().toISOString() })
      .eq("id", deal.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    if (canWriteThrough) {
      try {
        await updateDealStage(deal.pipedrive_deal_id!, { owner_id: body.ownerPipedriveId });
      } catch {
        await enqueuePdSync(db, "deal_update", {
          dealId: deal.pipedrive_deal_id,
          fields: { owner_id: body.ownerPipedriveId },
        });
        writeThroughError = "Pipedrive busy — queued, will sync automatically";
      }
    }
    await db.from("crm_activities").insert({
      deal_id: deal.id,
      type: "system",
      subject: "Owner reassigned",
      actor: user.email,
    });
  }

  if (body.stageId || body.status) {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    let pdStageId: number | null = null;
    if (body.stageId) {
      const { data: stage } = await db
        .from("crm_stages")
        .select("id, pipedrive_stage_id")
        .eq("id", body.stageId)
        .maybeSingle();
      if (!stage) return NextResponse.json({ error: "stage not found" }, { status: 400 });
      update.stage_id = stage.id;
      update.stage_changed_at = new Date().toISOString();
      pdStageId = stage.pipedrive_stage_id;
    }
    if (body.status) {
      if (!["open", "won", "lost"].includes(body.status)) {
        return NextResponse.json({ error: "bad status" }, { status: 400 });
      }
      update.status = body.status;
      if (body.status === "won") update.won_at = new Date().toISOString();
      if (body.status === "lost") {
        update.lost_at = new Date().toISOString();
        if (body.lostReason?.trim()) update.lost_reason = body.lostReason.trim();
      }
    }
    const { error } = await db.from("crm_deals").update(update).eq("id", deal.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    const pdFields = {
      stage_id: pdStageId ?? undefined,
      status: body.status,
      lost_reason: body.status === "lost" ? body.lostReason?.trim() || undefined : undefined,
    };
    if (canWriteThrough) {
      try {
        await updateDealStage(deal.pipedrive_deal_id!, pdFields);
      } catch {
        await enqueuePdSync(db, "deal_update", { dealId: deal.pipedrive_deal_id, fields: pdFields });
        writeThroughError = "Pipedrive busy — queued, will sync automatically";
      }
    }
    await db.from("crm_activities").insert({
      deal_id: deal.id,
      type: "system",
      subject: body.status
        ? `Marked ${body.status}${body.lostReason ? ` — ${body.lostReason.trim()}` : ""}`
        : "Stage changed",
      actor: user.email,
    });
    // Marking a reprospecting-pool deal lost ends its 3-day hold.
    if (body.status === "lost") {
      await resolveReprospect(db, {
        crmDealId: deal.id,
        repEmail: user.email,
        repPipedriveId: user.pipedriveUserId,
        event: "lost",
      });
    }
  }

  return NextResponse.json({ ok: true, writeThroughError });
}
