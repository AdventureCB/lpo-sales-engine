import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MACRO_COLS = "id, channel, name, subject, body, folder, sort_order, is_template, template_id, owner_email";

/**
 * Outreach library. TEMPLATES are the shared catalog anyone can add to;
 * each rep toggles a template on to get a personal editable COPY. The
 * composer uses the caller's personal macros. Admins can inspect any rep's
 * library via ?repEmail=.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const isAdmin = user.role === "admin";
  const viewEmail = (isAdmin && req.nextUrl.searchParams.get("repEmail")) || user.email;

  const [{ data: templates }, { data: mine }, { data: assets }, reps] = await Promise.all([
    db.from("comm_macros").select(MACRO_COLS).eq("is_template", true).order("channel").order("folder").order("name"),
    db.from("comm_macros").select(MACRO_COLS).eq("is_template", false).eq("owner_email", viewEmail).order("channel").order("folder").order("name"),
    db.from("comm_assets").select("*").order("kind").order("name"),
    isAdmin ? db.from("app_users").select("email, reps(name)").order("email") : Promise.resolve({ data: [] }),
  ]);

  // Which templates the viewed rep has toggled on.
  const enabledTemplateIds = new Set((mine ?? []).map((m) => m.template_id).filter(Boolean));

  return NextResponse.json({
    templates: templates ?? [],
    myMacros: mine ?? [],
    enabledTemplateIds: [...enabledTemplateIds],
    assets: assets ?? [],
    isAdmin,
    viewEmail,
    reps: (reps.data ?? []).map((u: any) => ({ email: u.email, name: u.reps?.name ?? u.email })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const isAdmin = user.role === "admin";

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const op = body.op as string;
  const CHANNELS = ["sms", "whatsapp", "email", "any"];

  // ── Templates (shared) — any user can add; edit/delete by creator or admin ──
  if (op === "template_upsert") {
    const m = body.macro ?? {};
    if (!m.name?.trim() || !m.body?.trim() || !CHANNELS.includes(m.channel)) {
      return NextResponse.json({ error: "channel, name, body required" }, { status: 400 });
    }
    if (m.id) {
      const { data: existing } = await db.from("comm_macros").select("owner_email").eq("id", m.id).maybeSingle();
      if (existing && existing.owner_email && existing.owner_email !== user.email && !isAdmin)
        return NextResponse.json({ error: "not your template" }, { status: 403 });
    }
    const row = {
      channel: m.channel,
      name: m.name.trim(),
      subject: m.subject?.trim() || null,
      body: m.body,
      folder: m.folder?.trim() || null,
      is_template: true,
      owner_email: m.id ? undefined : user.email, // creator (kept on update)
      updated_at: new Date().toISOString(),
    };
    if (m.id) {
      const { error } = await db.from("comm_macros").update(row).eq("id", m.id);
      if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
      return NextResponse.json({ ok: true, id: m.id });
    }
    const { data: created, error } = await db.from("comm_macros").insert(row).select("id").single();
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    return NextResponse.json({ ok: true, id: created?.id });
  }
  if (op === "template_delete" && body.id) {
    const { data: t } = await db.from("comm_macros").select("owner_email").eq("id", body.id).maybeSingle();
    if (t?.owner_email && t.owner_email !== user.email && !isAdmin)
      return NextResponse.json({ error: "not your template" }, { status: 403 });
    await db.from("comm_macros").delete().eq("id", body.id).eq("is_template", true);
    return NextResponse.json({ ok: true });
  }

  // ── Toggle a template into / out of the caller's personal library ──────────
  if (op === "toggle_template") {
    const { templateId, on } = body;
    if (!templateId) return NextResponse.json({ error: "templateId required" }, { status: 400 });
    if (on) {
      const { data: t } = await db.from("comm_macros").select(MACRO_COLS).eq("id", templateId).eq("is_template", true).maybeSingle();
      if (!t) return NextResponse.json({ error: "template not found" }, { status: 404 });
      // Idempotent: skip if already toggled on.
      const { data: dupe } = await db.from("comm_macros").select("id").eq("owner_email", user.email).eq("template_id", templateId).maybeSingle();
      if (!dupe) {
        await db.from("comm_macros").insert({
          channel: t.channel, name: t.name, subject: t.subject, body: t.body, folder: t.folder,
          is_template: false, owner_email: user.email, template_id: templateId,
        });
      }
    } else {
      await db.from("comm_macros").delete().eq("owner_email", user.email).eq("template_id", templateId);
    }
    return NextResponse.json({ ok: true });
  }

  // ── Personal macros — edit/delete only your own copies ─────────────────────
  if (op === "macro_upsert") {
    const m = body.macro ?? {};
    if (!m.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const { data: existing } = await db.from("comm_macros").select("owner_email").eq("id", m.id).maybeSingle();
    if (!existing || (existing.owner_email !== user.email && !isAdmin))
      return NextResponse.json({ error: "not your macro" }, { status: 403 });
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (m.name?.trim()) patch.name = m.name.trim();
    if (m.subject !== undefined) patch.subject = m.subject?.trim() || null;
    if (m.body?.trim()) patch.body = m.body;
    if (m.folder !== undefined) patch.folder = m.folder?.trim() || null;
    if (m.channel && CHANNELS.includes(m.channel)) patch.channel = m.channel;
    const { error } = await db.from("comm_macros").update(patch).eq("id", m.id);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  if (op === "macro_delete" && body.id) {
    await db.from("comm_macros").delete().eq("id", body.id).eq("owner_email", user.email);
    return NextResponse.json({ ok: true });
  }

  // ── Assets (shared) — admin-managed for now ────────────────────────────────
  if (op === "asset" || op === "asset_delete") {
    if (!isAdmin) return NextResponse.json({ error: "admin only" }, { status: 403 });
    if (op === "asset_delete" && body.id) {
      await db.from("comm_assets").delete().eq("id", body.id);
      return NextResponse.json({ ok: true });
    }
    const a = body.asset ?? {};
    if (!a.name?.trim() || !a.url?.trim() || !["url", "media"].includes(a.kind)) {
      return NextResponse.json({ error: "kind, name, url required" }, { status: 400 });
    }
    const row = { kind: a.kind, name: a.name.trim(), url: a.url.trim() };
    const q = a.id ? db.from("comm_assets").update(row).eq("id", a.id) : db.from("comm_assets").insert(row);
    const { error } = await q;
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}
