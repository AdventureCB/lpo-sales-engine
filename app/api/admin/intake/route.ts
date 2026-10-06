import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { getLists } from "@/lib/klaviyo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Intake Engine admin: list sources (+ rep roster for pool toggles), edit config. */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  const [{ data: sources }, { data: reps }, { data: recent }, { data: stageRows }, { data: dealSources }, klaviyoLists] = await Promise.all([
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
    // Deal-source catalog for the per-engine source picker.
    db.from("deal_sources").select("name").order("sort_order").order("name"),
    // Klaviyo lists for the web_form "subscribe to" picker (optional — the panel still renders without them).
    getLists().catch(() => [] as { id: string; name: string }[]),
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
  return NextResponse.json({
    sources: sources ?? [],
    reps: reps ?? [],
    counts,
    stages,
    dealSources: (dealSources ?? []).map((s: any) => s.name),
    klaviyoLists,
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { op?: string; id?: string; enabled?: boolean; label?: string; config?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();

  // Web forms are the one engine type admins add themselves: a new form on the
  // website = a new engine with its own key, title, source, pool, stage, list.
  if (body.op === "create_web_form") {
    const label = (body.label ?? "").trim();
    if (!label) return NextResponse.json({ error: "label required" }, { status: 400 });
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "form";
    const { data: dupe } = await db.from("intake_sources").select("id").eq("adapter", "web_form").eq("config->>form_key", key).maybeSingle();
    if (dupe) return NextResponse.json({ error: `a web form with key "${key}" already exists` }, { status: 409 });
    // Start from the Demo Request engine's pool/stage so new forms behave like the rest.
    const { data: tmpl } = await db.from("intake_sources").select("config").eq("adapter", "web_form").order("created_at").limit(1).maybeSingle();
    const base = (tmpl?.config ?? {}) as Record<string, unknown>;
    const config = {
      owner_pool: base.owner_pool ?? [],
      crm_stage_id: base.crm_stage_id,
      on_existing_open: "note",
      on_existing_closed: "reopen_assign",
      notify_owner: true,
      write_pipedrive: false,
      form_key: key,
      source_name: label,
      title_template: `${label} - {name}`,
    };
    const { data: created, error } = await db.from("intake_sources").insert({ label, adapter: "web_form", enabled: false, config }).select("id").single();
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    await db.from("deal_sources").upsert({ name: label }, { onConflict: "name", ignoreDuplicates: true });
    return NextResponse.json({ ok: true, id: created.id, formKey: key });
  }

  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  if (body.op === "delete") {
    // Only web forms are deletable, and only once disabled; intake_events cascade, deals stay.
    const { data: s } = await db.from("intake_sources").select("adapter, enabled").eq("id", body.id).maybeSingle();
    if (!s || s.adapter !== "web_form") return NextResponse.json({ error: "only web form engines can be deleted" }, { status: 400 });
    if (s.enabled) return NextResponse.json({ error: "disable it first" }, { status: 400 });
    const { error } = await db.from("intake_sources").delete().eq("id", body.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.label === "string" && body.label.trim()) patch.label = body.label.trim();
  if (body.config && typeof body.config === "object") patch.config = body.config;
  const { error } = await db.from("intake_sources").update(patch).eq("id", body.id);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
