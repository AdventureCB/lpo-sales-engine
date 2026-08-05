import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

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
