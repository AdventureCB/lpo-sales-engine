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

  let stageIds: number[];
  let pipelineId: number | undefined;
  let cacheKey: string;
  if (stageIdParam || pipelineParam) {
    stageIds = (stageIdParam ?? "").split(",").map(Number).filter(Number.isFinite);
    pipelineId = pipelineParam ? Number(pipelineParam) : undefined;
    cacheKey = `adhoc:${stageIdParam ?? ""}:${pipelineParam ?? ""}:${statusParam ?? ""}`;
  } else if (queueId) {
    const db = supabaseAdmin();
    const { data: q } = await db
      .from("queue_config")
      .select("id, stage_ids")
      .eq("id", queueId)
      .maybeSingle();
    if (!q) return NextResponse.json({ error: "queue not found" }, { status: 404 });
    stageIds = q.stage_ids;
    cacheKey = q.id;
  } else {
    return NextResponse.json({ error: "queueId or stageId required" }, { status: 400 });
  }

  try {
    const { leads, skippedNoPhone, skippedOwnership, truncated } = await cachedQueueLeads({
      user,
      stageIds,
      ownerScope: owner,
      nameContains,
      pipelineId,
      status,
      cacheKey,
    });
    return NextResponse.json({ leads, skippedNoPhone, skippedOwnership, truncated });
  } catch (e) {
    console.error("queue build failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
