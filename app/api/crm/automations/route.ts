import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List automations with recent run stats. Admin only. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const db = supabaseAdmin();
  const [autos, runs] = await Promise.all([
    db.from("crm_automations").select("*").order("created_at", { ascending: false }),
    db
      .from("crm_automation_runs")
      .select("automation_id, status, detail, ran_at")
      .order("ran_at", { ascending: false })
      .limit(100),
  ]);
  if (autos.error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ automations: autos.data ?? [], runs: runs.data ?? [] });
}

/** Create an automation (disabled by default). */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  let body: { name?: string; trigger?: object; conditions?: unknown[]; actions?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.name?.trim() || !body.trigger || !Array.isArray(body.actions) || body.actions.length === 0) {
    return NextResponse.json({ error: "name, trigger, actions required" }, { status: 400 });
  }
  const { error } = await supabaseAdmin().from("crm_automations").insert({
    name: body.name.trim(),
    trigger: body.trigger,
    conditions: body.conditions ?? [],
    actions: body.actions,
    enabled: false,
    created_by: user.email,
  });
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/** Toggle / delete. */
export async function PATCH(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { id?: string; enabled?: boolean; delete?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const db = supabaseAdmin();
  if (body.delete) {
    await db.from("crm_automation_runs").delete().eq("automation_id", body.id);
    const { error } = await db.from("crm_automations").delete().eq("id", body.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  const { error } = await db
    .from("crm_automations")
    .update({ enabled: Boolean(body.enabled) })
    .eq("id", body.id);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
