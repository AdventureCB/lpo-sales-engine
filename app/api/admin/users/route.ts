import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { normalizeEmail } from "@/lib/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin user management. A "user" = auth.users login + app_users (role) +
 * reps row (name, pipedrive_user_id — the ownership key everywhere).
 *
 * - create: provisions all three. Reps hired post-Pipedrive get a SYNTHETIC
 *   pipedrive_user_id (>= 900000000) so ownership/round-robin/scoreboard all
 *   work; PD write-through simply can't assign them (fails to outbox, fine
 *   under CRM-primary).
 * - deactivate: reps.active=false, disabled in every intake-engine pool,
 *   login banned. History (deals, activities, calls) untouched.
 * - reactivate: reverses the ban + active flag (pools stay off — re-enable
 *   per engine deliberately).
 * - delete: removes the LOGIN + app_users row (auth cascade). The reps row
 *   stays (inactive) so historical ownership still labels correctly.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  const [{ data: users }, { data: reps }, { data: engines }, { data: authList }] = await Promise.all([
    db.from("app_users").select("id, email, role, rep_id, created_at"),
    db.from("reps").select("id, name, email, pipedrive_user_id, quo_user_id, telnyx_number, active"),
    db.from("intake_sources").select("id, label, config"),
    db.auth.admin.listUsers({ perPage: 200 }),
  ]);
  // "Deactivated" = the LOGIN is banned. reps.active is a separate dial:
  // admins (Kyle/Cainen) have inactive rep rows just to stay off the
  // scoreboard/owner pickers — their logins are fine.
  const bannedByAuthId = new Map<string, boolean>();
  for (const au of (authList as any)?.users ?? []) {
    const b = (au as any).banned_until;
    bannedByAuthId.set(au.id, Boolean(b && new Date(b).getTime() > Date.now()));
  }
  const repById = new Map((reps ?? []).map((r) => [r.id, r]));
  // Which engine pools each rep (by pipedrive id) is enabled in.
  const poolsByPd = new Map<number, string[]>();
  for (const e of engines ?? []) {
    for (const p of ((e.config as any)?.owner_pool ?? []) as { pipedrive_id: number; enabled: boolean }[]) {
      if (!p.enabled) continue;
      poolsByPd.set(p.pipedrive_id, [...(poolsByPd.get(p.pipedrive_id) ?? []), e.label]);
    }
  }
  // Open-deal counts per owner for the deactivate hint.
  const { data: openCounts } = await db.rpc("open_deals_by_owner");
  const openByOwner = new Map<number, number>();
  for (const r of (openCounts ?? []) as any[]) openByOwner.set(Number(r.owner_pipedrive_id), Number(r.n));

  const linkedRepIds = new Set((users ?? []).map((u) => u.rep_id).filter(Boolean));
  return NextResponse.json({
    users: (users ?? []).map((u) => {
      const rep = u.rep_id ? repById.get(u.rep_id) : null;
      return {
        authUserId: u.id,
        email: u.email,
        role: u.role,
        repId: u.rep_id,
        name: rep?.name ?? null,
        pipedriveUserId: rep?.pipedrive_user_id ?? null,
        telnyxNumber: rep?.telnyx_number ?? null,
        active: !bannedByAuthId.get(u.id), // login usable
        repActive: rep ? rep.active : null, // on scoreboard/owner pickers
        pools: rep?.pipedrive_user_id ? poolsByPd.get(rep.pipedrive_user_id) ?? [] : [],
        openDeals: rep?.pipedrive_user_id ? openByOwner.get(rep.pipedrive_user_id) ?? 0 : 0,
        createdAt: u.created_at,
      };
    }),
    // Reps with no login (legacy rows) — attachable when creating a user.
    unlinkedReps: (reps ?? [])
      .filter((r) => !linkedRepIds.has(r.id))
      .map((r) => ({ repId: r.id, name: r.name, email: r.email, pipedriveUserId: r.pipedrive_user_id, active: r.active })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: {
    op?: "create" | "update" | "deactivate" | "reactivate" | "delete";
    authUserId?: string;
    email?: string;
    name?: string;
    role?: "admin" | "sales";
    password?: string;
    pipedriveUserId?: number | null;
    linkRepId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();

  if (body.op === "create") {
    const email = normalizeEmail(body.email ?? "");
    const name = body.name?.trim();
    const role = body.role === "admin" ? "admin" : "sales";
    const password = body.password ?? "";
    if (!email || !name || password.length < 8) {
      return NextResponse.json({ error: "email, name, and a password (8+ chars) required" }, { status: 400 });
    }
    const { data: created, error: authErr } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (authErr || !created?.user) {
      return NextResponse.json({ error: `auth: ${authErr?.message ?? "create failed"}` }, { status: 400 });
    }
    // Rep row: link an existing unlinked one, or create with a real/synthetic PD id.
    let repId = body.linkRepId ?? null;
    if (repId) {
      await db.from("reps").update({ name, email, active: true }).eq("id", repId);
    } else {
      const pdId = body.pipedriveUserId ?? 900_000_000 + (Math.floor(Date.now() / 1000) % 100_000_000);
      const { data: rep, error: repErr } = await db
        .from("reps")
        .insert({ name, email, pipedrive_user_id: pdId, active: true })
        .select("id")
        .single();
      if (repErr || !rep) {
        await db.auth.admin.deleteUser(created.user.id);
        return NextResponse.json({ error: `rep: ${repErr?.message ?? "insert failed"}` }, { status: 400 });
      }
      repId = rep.id;
    }
    const { error: appErr } = await db.from("app_users").insert({ id: created.user.id, email, role, rep_id: repId });
    if (appErr) {
      await db.auth.admin.deleteUser(created.user.id);
      return NextResponse.json({ error: `app_users: ${appErr.message}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, authUserId: created.user.id });
  }

  // Everything else operates on an existing user.
  if (!body.authUserId) return NextResponse.json({ error: "authUserId required" }, { status: 400 });
  const { data: target } = await db
    .from("app_users")
    .select("id, email, role, rep_id, reps ( id, pipedrive_user_id )")
    .eq("id", body.authUserId)
    .maybeSingle();
  if (!target) return NextResponse.json({ error: "user not found" }, { status: 404 });
  const targetRep = (Array.isArray(target.reps) ? target.reps[0] : target.reps) as { id: string; pipedrive_user_id: number | null } | null;
  const isSelf = target.id === user.authUserId;

  /** Flip this rep's enabled flag in every intake-engine round-robin pool. */
  const setPools = async (enabled: boolean) => {
    if (!targetRep?.pipedrive_user_id) return;
    const { data: engines } = await db.from("intake_sources").select("id, config");
    for (const e of engines ?? []) {
      const cfg = (e.config as any) ?? {};
      const pool = (cfg.owner_pool ?? []) as { pipedrive_id: number; enabled: boolean }[];
      if (!pool.some((p) => p.pipedrive_id === targetRep.pipedrive_user_id && p.enabled !== enabled)) continue;
      const next = pool.map((p) => (p.pipedrive_id === targetRep.pipedrive_user_id ? { ...p, enabled } : p));
      await db.from("intake_sources").update({ config: { ...cfg, owner_pool: next }, updated_at: new Date().toISOString() }).eq("id", e.id);
    }
  };

  if (body.op === "update") {
    if (body.role && !isSelf) await db.from("app_users").update({ role: body.role }).eq("id", target.id);
    if (targetRep && (body.name?.trim() || body.pipedriveUserId !== undefined)) {
      const patch: Record<string, unknown> = {};
      if (body.name?.trim()) patch.name = body.name.trim();
      if (body.pipedriveUserId !== undefined && body.pipedriveUserId !== null) patch.pipedrive_user_id = body.pipedriveUserId;
      if (Object.keys(patch).length) {
        const { error } = await db.from("reps").update(patch).eq("id", targetRep.id);
        if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    if (body.password) {
      if (body.password.length < 8) return NextResponse.json({ error: "password too short" }, { status: 400 });
      const { error } = await db.auth.admin.updateUserById(target.id, { password: body.password });
      if (error) return NextResponse.json({ error: `auth: ${error.message}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.op === "deactivate") {
    if (isSelf) return NextResponse.json({ error: "you can't deactivate yourself" }, { status: 400 });
    if (targetRep) await db.from("reps").update({ active: false }).eq("id", targetRep.id);
    await setPools(false);
    await db.auth.admin.updateUserById(target.id, { ban_duration: "876000h" }); // ~100y
    return NextResponse.json({ ok: true });
  }

  if (body.op === "reactivate") {
    // Admins keep an inactive rep row (they stay off the scoreboard/pickers);
    // sales reps come back fully.
    if (targetRep && target.role === "sales") await db.from("reps").update({ active: true }).eq("id", targetRep.id);
    await db.auth.admin.updateUserById(target.id, { ban_duration: "none" });
    return NextResponse.json({ ok: true, note: "engine pools stay off — re-enable per engine" });
  }

  if (body.op === "delete") {
    if (isSelf) return NextResponse.json({ error: "you can't delete yourself" }, { status: 400 });
    if (targetRep) await db.from("reps").update({ active: false }).eq("id", targetRep.id);
    await setPools(false);
    const { error } = await db.auth.admin.deleteUser(target.id); // app_users cascades
    if (error) return NextResponse.json({ error: `auth: ${error.message}` }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}
