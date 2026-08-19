import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { enqueuePdSync } from "@/lib/pd-sync";
import { envOptional } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scheduled activities in a date range for the calendar. Sales reps see
 * their own (created by them or on deals they own); admins see everyone's
 * and filter client-side.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const p = new URL(req.url).searchParams;
  const start = p.get("start");
  const end = p.get("end");
  if (!start || !end) return NextResponse.json({ error: "start and end required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("crm_activities")
    .select(
      "id, type, subject, due_at, done_at, actor, deal_id, crm_deals ( id, title, owner_pipedrive_id, crm_contacts ( name ) )"
    )
    .not("due_at", "is", null)
    .gte("due_at", start)
    .lte("due_at", end)
    .order("due_at")
    .limit(1000);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  let rows = data ?? [];
  if (user.role !== "admin") {
    rows = rows.filter(
      (a: any) =>
        a.actor === user.email ||
        (user.pipedriveUserId && a.crm_deals?.owner_pipedrive_id === user.pipedriveUserId)
    );
  }

  return NextResponse.json({
    activities: rows.map((a: any) => ({
      id: a.id,
      type: a.type,
      subject: a.subject,
      dueAt: a.due_at,
      done: Boolean(a.done_at),
      actor: a.actor,
      dealId: a.crm_deals?.id ?? null,
      dealTitle: a.crm_deals?.title ?? null,
      contactName: a.crm_deals?.crm_contacts?.name ?? null,
      ownerPipedriveId: a.crm_deals?.owner_pipedrive_id ?? null,
    })),
    truncated: rows.length >= 1000,
  });
}

/**
 * Bulk actions on scheduled activities: mark done or delete. Same visibility
 * rule as GET — reps act only on activities they created or on deals they
 * own; admins on anything. Pipedrive-linked rows sync via the outbox.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { action?: string; ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const action = body.action;
  const ids = (body.ids ?? []).filter((x) => typeof x === "string").slice(0, 300);
  if (!["done", "delete"].includes(action ?? "") || ids.length === 0) {
    return NextResponse.json({ error: "action (done|delete) and ids required" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: rows } = await db
    .from("crm_activities")
    .select("id, actor, pipedrive_activity_id, crm_deals ( owner_pipedrive_id )")
    .in("id", ids);
  const allowed = (rows ?? []).filter(
    (a: any) =>
      user.role === "admin" ||
      a.actor === user.email ||
      (user.pipedriveUserId && a.crm_deals?.owner_pipedrive_id === user.pipedriveUserId)
  );
  if (allowed.length === 0) return NextResponse.json({ error: "nothing you can modify" }, { status: 403 });
  const allowedIds = allowed.map((a: any) => a.id);

  const { error } =
    action === "done"
      ? await db.from("crm_activities").update({ done_at: new Date().toISOString() }).in("id", allowedIds)
      : await db.from("crm_activities").delete().in("id", allowedIds);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  if (envOptional("PIPEDRIVE_API_TOKEN")) {
    for (const a of allowed as any[]) {
      if (!a.pipedrive_activity_id) continue;
      await enqueuePdSync(
        db,
        action === "done" ? "activity_done" : "activity_delete",
        { pipedriveActivityId: a.pipedrive_activity_id }
      );
    }
  }

  return NextResponse.json({ ok: true, affected: allowedIds.length, skipped: ids.length - allowedIds.length });
}
