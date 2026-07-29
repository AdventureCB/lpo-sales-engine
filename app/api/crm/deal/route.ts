import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { envOptional } from "@/lib/env";
import { updateDealStage, addDealNote } from "@/lib/pipedrive";

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

  const [activities, calls, stages] = await Promise.all([
    db
      .from("crm_activities")
      .select("id, type, subject, body, actor, due_at, done_at, occurred_at")
      .eq("deal_id", id)
      .order("occurred_at", { ascending: false })
      .limit(50),
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
  ]);

  const timeline = [
    ...(activities.data ?? []).map((a) => ({
      kind: a.type,
      at: a.occurred_at,
      title: a.subject ?? a.type,
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

  return NextResponse.json({ deal, timeline, stages: stages.data ?? [] });
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

  let body: { id?: string; stageId?: string; status?: string; note?: string; ownerPipedriveId?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: deal } = await db
    .from("crm_deals")
    .select("id, pipedrive_deal_id")
    .eq("id", body.id)
    .maybeSingle();
  if (!deal) return NextResponse.json({ error: "not found" }, { status: 404 });

  let writeThroughError: string | null = null;
  const canWriteThrough = Boolean(envOptional("PIPEDRIVE_API_TOKEN")) && deal.pipedrive_deal_id;

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
