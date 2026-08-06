import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pipeline + stage registry. Prefilled from Pipedrive but editable in-app
 * with no write-back (we own these once cutover happens). GET = everyone;
 * mutations = admin.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const [{ data: pipelines }, { data: stages }] = await Promise.all([
    db.from("crm_pipelines").select("id, name, sort_order").order("sort_order").order("name"),
    db.from("crm_stages").select("id, name, pipeline_id, sort_order").order("sort_order"),
  ]);
  // Deal counts per stage — the editor blocks deleting a stage in use.
  const { data: counts } = await db.rpc("stage_deal_counts");
  const countByStage = new Map((counts ?? []).map((c: any) => [c.stage_id, Number(c.n)]));
  return NextResponse.json({
    pipelines: (pipelines ?? []).map((p) => ({
      ...p,
      stages: (stages ?? [])
        .filter((s) => s.pipeline_id === p.id)
        .map((s) => ({ ...s, dealCount: countByStage.get(s.id) ?? 0 })),
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  let body: {
    op?: string;
    id?: string;
    name?: string;
    pipelineId?: string;
    dir?: "up" | "down";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();

  switch (body.op) {
    case "pipeline_save": {
      if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
      if (body.id) {
        await db.from("crm_pipelines").update({ name: body.name.trim() }).eq("id", body.id);
      } else {
        const { data: mx } = await db.from("crm_pipelines").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
        await db.from("crm_pipelines").insert({ name: body.name.trim(), sort_order: (mx?.sort_order ?? 0) + 1 });
      }
      return NextResponse.json({ ok: true });
    }
    case "pipeline_delete": {
      if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { data: inUse } = await db.rpc("pipeline_deal_count", { p_pipeline: body.id });
      if (Number(inUse ?? 0) > 0) {
        return NextResponse.json({ error: `${inUse} deals are in this pipeline — move them first` }, { status: 409 });
      }
      await db.from("crm_stages").delete().eq("pipeline_id", body.id);
      await db.from("crm_pipelines").delete().eq("id", body.id);
      return NextResponse.json({ ok: true });
    }
    case "stage_save": {
      if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
      if (body.id) {
        await db.from("crm_stages").update({ name: body.name.trim() }).eq("id", body.id);
      } else {
        if (!body.pipelineId) return NextResponse.json({ error: "pipelineId required" }, { status: 400 });
        const { data: mx } = await db.from("crm_stages").select("sort_order").eq("pipeline_id", body.pipelineId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
        await db.from("crm_stages").insert({ name: body.name.trim(), pipeline_id: body.pipelineId, sort_order: (mx?.sort_order ?? 0) + 1 });
      }
      return NextResponse.json({ ok: true });
    }
    case "stage_delete": {
      if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { count } = await db.from("crm_deals").select("id", { count: "exact", head: true }).eq("stage_id", body.id);
      if ((count ?? 0) > 0) {
        return NextResponse.json({ error: `${count} deals are in this stage — move them first` }, { status: 409 });
      }
      await db.from("crm_stages").delete().eq("id", body.id);
      return NextResponse.json({ ok: true });
    }
    case "stage_reorder": {
      // Swap sort_order with the adjacent stage in the same pipeline.
      if (!body.id || !body.dir) return NextResponse.json({ error: "id and dir required" }, { status: 400 });
      const { data: s } = await db.from("crm_stages").select("id, pipeline_id, sort_order").eq("id", body.id).maybeSingle();
      if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });
      const asc = body.dir === "down";
      const { data: neighbor } = await db
        .from("crm_stages")
        .select("id, sort_order")
        .eq("pipeline_id", s.pipeline_id)
        .filter("sort_order", asc ? "gt" : "lt", s.sort_order)
        .order("sort_order", { ascending: asc })
        .limit(1)
        .maybeSingle();
      if (!neighbor) return NextResponse.json({ ok: true }); // already at the end
      await db.from("crm_stages").update({ sort_order: neighbor.sort_order }).eq("id", s.id);
      await db.from("crm_stages").update({ sort_order: s.sort_order }).eq("id", neighbor.id);
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }
}
