import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Intake Engine admin: list sources (+ rep roster for pool toggles), edit config. */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  const [{ data: sources }, { data: reps }, { data: recent }, { data: stageRows }] = await Promise.all([
    db.from("intake_sources").select("*").order("created_at"),
    db.from("reps").select("name, pipedrive_user_id").eq("active", true).not("pipedrive_user_id", "is", null),
    db
      .from("intake_events")
      .select("source_id, action")
      .gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString()),
    // Pipelines + stages for the per-engine default-stage picker (uuid-keyed so
    // native stages with no Pipedrive id, e.g. Hot List Import, are selectable).
    db
      .from("crm_stages")
      .select("id, name, pipedrive_stage_id, sort_order, crm_pipelines ( name, sort_order, pipedrive_pipeline_id )")
      .order("sort_order"),
  ]);
  // 7-day action counts per source for the panel header.
  const counts: Record<string, Record<string, number>> = {};
  for (const e of recent ?? []) {
    counts[e.source_id] = counts[e.source_id] ?? {};
    counts[e.source_id][e.action] = (counts[e.source_id][e.action] ?? 0) + 1;
  }
  const stages = (stageRows ?? [])
    .map((s: any) => ({
      id: s.id,
      name: s.name,
      pipedriveStageId: s.pipedrive_stage_id,
      pipeline: s.crm_pipelines?.name ?? "—",
      pipelineSort: s.crm_pipelines?.sort_order ?? 99,
    }))
    .sort((a, b) => a.pipelineSort - b.pipelineSort);
  return NextResponse.json({ sources: sources ?? [], reps: reps ?? [], counts, stages });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { id?: string; enabled?: boolean; label?: string; config?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.label === "string" && body.label.trim()) patch.label = body.label.trim();
  if (body.config && typeof body.config === "object") patch.config = body.config;
  const { error } = await supabaseAdmin().from("intake_sources").update(patch).eq("id", body.id);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
