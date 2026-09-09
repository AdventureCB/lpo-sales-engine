import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ⭐ Priority follow-ups for the countdown watcher: the caller's own undone
 * priority activities due between 2h ago and 12h from now. Light poll —
 * the client does all countdown math locally.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const { data } = await db
    .from("crm_activities")
    .select("id, subject, type, due_at, deal_id, crm_deals ( id, title )")
    .eq("actor", user.email)
    .contains("meta", { priority: true })
    .is("done_at", null)
    .gte("due_at", new Date(Date.now() - 2 * 3600_000).toISOString())
    .lte("due_at", new Date(Date.now() + 12 * 3600_000).toISOString())
    .order("due_at")
    .limit(10);
  return NextResponse.json({
    items: (data ?? []).map((a: any) => ({
      id: a.id,
      subject: a.subject,
      type: a.type,
      dueAt: a.due_at,
      dealId: (a.crm_deals as any)?.id ?? a.deal_id,
      dealTitle: (a.crm_deals as any)?.title ?? null,
    })),
  });
}

/** Mark one of your priority follow-ups done from the popup. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const db = supabaseAdmin();
  const { error } = await db
    .from("crm_activities")
    .update({ done_at: new Date().toISOString() })
    .eq("id", body.id)
    .eq("actor", user.email);
  return NextResponse.json({ ok: !error });
}
