import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { cachedQueueLeads, type OwnerScope } from "@/lib/dialer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Ordered lead list for one queue (or an ad-hoc stage filter). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const owner = (params.get("owner") ?? "both") as OwnerScope;
  const nameContains = params.get("name") ?? undefined;
  const queueId = params.get("queueId");
  const stageIdParam = params.get("stageId");
  const pipelineParam = params.get("pipelineId");
  const statusParam = params.get("status");
  const status = ["open", "won", "lost"].includes(statusParam ?? "")
    ? (statusParam as "open" | "won" | "lost")
    : undefined;

  // Sprint queues read from the CRM mirror — no Pipedrive involved.
  if (queueId?.startsWith("sprint:")) {
    const sprintId = queueId.slice(7);
    const db = supabaseAdmin();
    const { data: sprint } = await db
      .from("crm_sprints")
      .select("id, owner")
      .eq("id", sprintId)
      .maybeSingle();
    if (!sprint) return NextResponse.json({ error: "sprint not found" }, { status: 404 });
    if (user.role !== "admin" && sprint.owner !== user.email) {
      return NextResponse.json({ error: "not your sprint" }, { status: 403 });
    }
    const { data: items, error } = await db
      .from("crm_sprint_items")
      .select(
        "position, called_at, flag, crm_deals ( id, title, pipedrive_deal_id, crm_stages ( name ), crm_contacts ( name, phones ) )"
      )
      .eq("sprint_id", sprintId)
      .is("called_at", null)
      .is("removed_at", null)
      .order("position");
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    let skippedNoPhone = 0;
    const leads = (items ?? [])
      .map((it: any) => {
        const d = it.crm_deals;
        const phones = d?.crm_contacts?.phones ?? [];
        const phone =
          phones.find((p: any) => p.primary && p.e164)?.e164 ??
          phones.find((p: any) => p.e164)?.e164 ??
          null;
        if (!phone) {
          skippedNoPhone++;
          return null;
        }
        return {
          dealId: d.pipedrive_deal_id,
          crmDealId: d.id,
          sprintId,
          title: d.title,
          personName: d.crm_contacts?.name ?? null,
          phone,
          stageName: d.crm_stages?.name ?? "—",
          hot: !!it.flag,
          hotReason: it.flag ?? null,
        };
      })
      .filter(Boolean);
    return NextResponse.json({ leads, skippedNoPhone, skippedOwnership: 0, truncated: false });
  }

  let stageIds: number[];
  let pipelineId: number | undefined;
  let cacheKey: string;
  let poolMode = false;
  if (stageIdParam || pipelineParam) {
    stageIds = (stageIdParam ?? "").split(",").map(Number).filter(Number.isFinite);
    pipelineId = pipelineParam ? Number(pipelineParam) : undefined;
    cacheKey = `adhoc:${stageIdParam ?? ""}:${pipelineParam ?? ""}:${statusParam ?? ""}`;
  } else if (queueId) {
    const db = supabaseAdmin();
    const { data: q } = await db
      .from("queue_config")
      .select("id, stage_ids, pool_mode")
      .eq("id", queueId)
      .maybeSingle();
    if (!q) return NextResponse.json({ error: "queue not found" }, { status: 404 });
    stageIds = q.stage_ids;
    poolMode = q.pool_mode ?? false;
    cacheKey = q.id;
  } else {
    return NextResponse.json({ error: "queueId or stageId required" }, { status: 400 });
  }

  try {
    const { leads, skippedNoPhone, skippedOwnership, truncated, pool } = await cachedQueueLeads({
      user,
      stageIds,
      ownerScope: owner,
      nameContains,
      pipelineId,
      status,
      poolMode,
      takeLeases: true,
      cacheKey,
    });
    // Persist the count from this real build — the queue list serves these
    // instead of spending Pipedrive calls to recount.
    if (queueId) {
      await supabaseAdmin()
        .from("queue_counts")
        .upsert(
          {
            queue_id: queueId,
            actor: user.email,
            owner_scope: owner,
            count: pool ? pool.eligible : leads.length,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "queue_id,actor,owner_scope" }
        );
    }
    return NextResponse.json({ leads, skippedNoPhone, skippedOwnership, truncated, pool });
  } catch (e) {
    console.error("queue build failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
