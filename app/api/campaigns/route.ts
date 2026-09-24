import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Campaign builder API.
 *   GET            → campaigns visible to me (+ steps, stats), plus pickers (macros, sources, pipelines)
 *   POST           → create/update {id?, name, channel, mode, status, shared, trigger, settings, steps: [...]}
 *   DELETE ?id=    → archive
 * Reps may build macro campaigns; AI mode is admin-only (Kyle 9/24).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const isAdmin = user.role === "admin";
  let q = db.from("campaigns").select("*, campaign_steps ( * )").neq("status", "archived").order("created_at", { ascending: false });
  if (!isAdmin) q = q.or(`shared.eq.true,owner_email.eq.${user.email}`);
  const [{ data: camps }, { data: macros }, { data: sources }, { data: pipelines }, { data: enrs }] = await Promise.all([
    q,
    db.from("comm_macros").select("id, name, channel, subject").in("channel", ["email", "sms", "any"]).order("sort_order").order("name"),
    db.from("deal_sources").select("name").order("sort_order").order("name"),
    db.from("crm_pipelines").select("name").order("sort_order"),
    db.from("campaign_enrollments").select("campaign_id, status"),
  ]);
  const stats: Record<string, { active: number; completed: number; exited: number }> = {};
  for (const e of enrs ?? []) {
    const s = (stats[e.campaign_id] = stats[e.campaign_id] ?? { active: 0, completed: 0, exited: 0 });
    if (e.status === "active") s.active++; else if (e.status === "completed") s.completed++; else s.exited++;
  }
  // Per-step outcomes: sent / opened / clicked (email_tracking) / replied
  // (enrollment exited "customer replied" after that step).
  const { data: sends } = await db.from("campaign_sends").select("campaign_id, step_position, track_token, enrollment_id").eq("status", "sent").limit(5000);
  const tokens = (sends ?? []).map((x: any) => x.track_token).filter(Boolean);
  const tracked = new Map<string, { opened: boolean; clicked: boolean }>();
  for (let i = 0; i < tokens.length; i += 500) {
    const { data: tr } = await db.from("email_tracking").select("token, first_open_at, last_click_at").in("token", tokens.slice(i, i + 500));
    for (const t of tr ?? []) tracked.set(t.token, { opened: !!t.first_open_at, clicked: !!t.last_click_at });
  }
  const { data: replied } = await db.from("campaign_enrollments").select("id, campaign_id, current_step").eq("exit_reason", "customer replied");
  const repliedAfter = new Map((replied ?? []).map((e: any) => [e.id, e.current_step - 1]));
  const stepStats: Record<string, Record<number, { sent: number; opened: number; clicked: number; replied: number }>> = {};
  for (const x of (sends ?? []) as any[]) {
    const st = ((stepStats[x.campaign_id] ??= {})[x.step_position] ??= { sent: 0, opened: 0, clicked: 0, replied: 0 });
    st.sent++;
    const t = x.track_token ? tracked.get(x.track_token) : null;
    if (t?.opened) st.opened++;
    if (t?.clicked) st.clicked++;
    if (repliedAfter.get(x.enrollment_id) === x.step_position) st.replied++;
  }
  return NextResponse.json({
    isAdmin,
    me: user.email,
    campaigns: (camps ?? []).map((c: any) => ({ ...c, campaign_steps: [...(c.campaign_steps ?? [])].sort((a: any, b: any) => a.position - b.position), stats: stats[c.id] ?? { active: 0, completed: 0, exited: 0 }, stepStats: stepStats[c.id] ?? {} })),
    macros: macros ?? [],
    sources: (sources ?? []).map((s: any) => s.name),
    pipelines: (pipelines ?? []).map((p: any) => p.name),
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();
  const isAdmin = user.role === "admin";
  const name = String(body.name ?? "").trim().slice(0, 120);
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const channel = body.channel === "sms" ? "sms" : "email";
  const mode = body.mode === "ai" ? "ai" : "macro";
  if (mode === "ai" && !isAdmin) return NextResponse.json({ error: "AI campaigns are admin-only for now" }, { status: 403 });
  const status = ["draft", "active", "paused"].includes(body.status) ? body.status : "draft";
  const trigger = body.trigger && typeof body.trigger === "object" ? body.trigger : { type: "manual" };
  const settings = body.settings && typeof body.settings === "object" ? body.settings : {};
  const steps: any[] = Array.isArray(body.steps) ? body.steps : [];
  if (status === "active" && steps.length === 0) return NextResponse.json({ error: "Add at least one step before activating." }, { status: 400 });
  for (const s of steps) {
    if (s.content_kind === "prompt" && !isAdmin) return NextResponse.json({ error: "AI steps are admin-only" }, { status: 403 });
    if (s.content_kind === "inline" && (!String(s.body ?? "").trim() || (channel === "email" && !String(s.subject ?? "").trim()))) return NextResponse.json({ error: channel === "email" ? "Every written step needs a subject and body." : "Every written step needs a message." }, { status: 400 });
    if (channel === "sms" && s.content_kind === "inline" && String(s.body ?? "").length > 480) return NextResponse.json({ error: "Text steps should stay under 480 characters." }, { status: 400 });
    if (s.content_kind === "macro" && !s.macro_id) return NextResponse.json({ error: "Pick a macro for each macro step." }, { status: 400 });
  }

  let id: string = body.id;
  if (id) {
    const { data: existing } = await db.from("campaigns").select("owner_email").eq("id", id).maybeSingle();
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!isAdmin && existing.owner_email !== user.email) return NextResponse.json({ error: "not your campaign" }, { status: 403 });
    const { error } = await db.from("campaigns").update({ name, channel, mode, status, shared: body.shared !== false, trigger, settings, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { data, error } = await db
      .from("campaigns")
      .insert({ name, channel, mode, status, shared: body.shared !== false, owner_email: user.email, created_by: user.email, trigger, settings })
      .select("id")
      .single();
    if (error || !data) return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
    id = data.id;
  }
  // Steps: replace wholesale, keeping ids where given so sent history stays linked.
  const keep = steps.map((s) => s.id).filter(Boolean);
  let del = db.from("campaign_steps").delete().eq("campaign_id", id);
  if (keep.length) del = del.not("id", "in", `(${keep.join(",")})`);
  await del;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const row = {
      campaign_id: id, position: i, delay_hours: Math.max(0, Math.min(24 * 90, Math.round(Number(s.delay_hours ?? 48)))),
      content_kind: ["inline", "macro", "prompt"].includes(s.content_kind) ? s.content_kind : "inline",
      macro_id: s.content_kind === "macro" ? s.macro_id ?? null : null,
      subject: String(s.subject ?? "").slice(0, 200) || null, body: String(s.body ?? "").slice(0, 20_000) || null,
      prompt: String(s.prompt ?? "").slice(0, 4000) || null, steering: String(s.steering ?? "").slice(0, 2000) || null,
      conditions: s.conditions && typeof s.conditions === "object" ? s.conditions : {},
    };
    if (s.id) await db.from("campaign_steps").update(row).eq("id", s.id).eq("campaign_id", id);
    else await db.from("campaign_steps").insert(row);
  }
  return NextResponse.json({ ok: true, id });
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const db = supabaseAdmin();
  const { data: c } = await db.from("campaigns").select("owner_email").eq("id", id).maybeSingle();
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (user.role !== "admin" && c.owner_email !== user.email) return NextResponse.json({ error: "not your campaign" }, { status: 403 });
  await db.from("campaigns").update({ status: "archived", updated_at: new Date().toISOString() }).eq("id", id);
  return NextResponse.json({ ok: true });
}
