import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { envOptional } from "@/lib/env";
import { updateDealStage, addDealNote, createActivity, updateActivity } from "@/lib/pipedrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deal detail: full record + timeline (native activities ∪ captured calls). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: deal, error } = await db
    .from("crm_deals")
    .select(
      "*, crm_stages ( id, name, pipeline_id, crm_pipelines ( id, name ) ), crm_contacts ( id, name, emails, phones, org_name )"
    )
    .eq("id", id)
    .maybeSingle();
  if (error || !deal) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Quo logs calls/notes on the person, not the deal — pull the contact's
  // activities into the deal timeline too, or most history is invisible.
  const activityFilter = deal.contact_id
    ? `deal_id.eq.${id},contact_id.eq.${deal.contact_id}`
    : `deal_id.eq.${id}`;
  const [activities, calls, stages, sprints, dealSprints, owners] = await Promise.all([
    db
      .from("crm_activities")
      .select("id, type, subject, body, actor, due_at, done_at, occurred_at, deal_id")
      .or(activityFilter)
      .order("occurred_at", { ascending: false })
      .limit(150),
    deal.pipedrive_deal_id
      ? db
          .from("call_events")
          .select("quo_call_id, direction, started_at, duration_s, classification, disposition")
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
    db.from("crm_sprint_items").select("sprint_id").eq("deal_id", id),
    db.from("app_users").select("email, role").order("email"),
  ]);

  const timeline = [
    ...(activities.data ?? []).map((a) => ({
      id: a.id,
      kind: a.type,
      at: a.occurred_at,
      title: (a.subject ?? a.type) + (a.deal_id === id ? "" : " · (contact)"),
      body: a.body,
      actor: a.actor,
      done: Boolean(a.done_at),
      due: a.due_at,
    })),
    ...((calls as any).data ?? []).map((c: any) => ({
      kind: "call",
      at: c.started_at,
      title: `${c.direction === "incoming" ? "Inbound" : "Outbound"} call · ${c.classification ?? "—"}${c.disposition ? ` · ${c.disposition}` : ""}`,
      body: c.duration_s ? `${Math.round(c.duration_s / 60)}m ${c.duration_s % 60}s` : null,
      actor: null,
      done: true,
      due: null,
    })),
  ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  return NextResponse.json({
    deal,
    timeline,
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
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  let body: {
    id?: string;
    stageId?: string;
    status?: string;
    note?: string;
    ownerPipedriveId?: number;
    activity?: { type: string; subject: string; dueAt?: string | null };
    completeActivityId?: string;
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

  // Schedule an activity (call / task / meeting / email) with a due time.
  if (body.activity) {
    const { type, subject, dueAt } = body.activity;
    if (!["call", "task", "meeting", "email"].includes(type) || !subject?.trim()) {
      return NextResponse.json({ error: "activity type/subject invalid" }, { status: 400 });
    }
    let pipedriveActivityId: number | null = null;
    if (canWriteThrough) {
      try {
        pipedriveActivityId = await createActivity({
          dealId: deal.pipedrive_deal_id!,
          subject: subject.trim(),
          type,
          dueAtIso: dueAt ?? null,
        });
      } catch (e) {
        writeThroughError = e instanceof Error ? e.message : String(e);
      }
    }
    const { error } = await db.from("crm_activities").insert({
      deal_id: deal.id,
      contact_id: deal.contact_id,
      type,
      subject: subject.trim(),
      actor: user.email,
      due_at: dueAt ?? null,
      occurred_at: new Date().toISOString(),
      pipedrive_activity_id: pipedriveActivityId,
    });
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
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
      } catch (e) {
        writeThroughError = e instanceof Error ? e.message : String(e);
      }
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
    const { error } = await db.from("crm_activities").insert({
      deal_id: deal.id,
      type: "note",
      body: body.note.trim(),
      actor: user.email,
    });
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    if (canWriteThrough) {
      try {
        await addDealNote(deal.pipedrive_deal_id!, body.note.trim());
      } catch (e) {
        writeThroughError = e instanceof Error ? e.message : String(e);
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
      } catch (e) {
        writeThroughError = e instanceof Error ? e.message : String(e);
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
      if (body.status === "lost") update.lost_at = new Date().toISOString();
    }
    const { error } = await db.from("crm_deals").update(update).eq("id", deal.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    if (canWriteThrough) {
      try {
        await updateDealStage(deal.pipedrive_deal_id!, {
          stage_id: pdStageId ?? undefined,
          status: body.status,
        });
      } catch (e) {
        writeThroughError = e instanceof Error ? e.message : String(e);
      }
    }
    await db.from("crm_activities").insert({
      deal_id: deal.id,
      type: "system",
      subject: body.stageId ? "Stage changed" : `Marked ${body.status}`,
      actor: user.email,
    });
  }

  return NextResponse.json({ ok: true, writeThroughError });
}
