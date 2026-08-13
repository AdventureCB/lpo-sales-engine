import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lightweight peek for the CRM list drop-down: last 3 activities + the next
 * scheduled one. Matches activities by deal or its contact. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dealId = req.nextUrl.searchParams.get("dealId");
  if (!dealId) return NextResponse.json({ error: "dealId required" }, { status: 400 });
  const db = supabaseAdmin();

  const { data: deal } = await db.from("crm_deals").select("contact_id").eq("id", dealId).maybeSingle();
  const orFilter = deal?.contact_id ? `deal_id.eq.${dealId},contact_id.eq.${deal.contact_id}` : `deal_id.eq.${dealId}`;
  const nowIso = new Date().toISOString();

  const [{ data: recent }, { data: upcoming }] = await Promise.all([
    db
      .from("crm_activities")
      .select("type, subject, body, occurred_at, done_at, due_at")
      .or(orFilter)
      .order("occurred_at", { ascending: false })
      .limit(3),
    db
      .from("crm_activities")
      .select("type, subject, due_at")
      .or(orFilter)
      .is("done_at", null)
      .gt("due_at", nowIso)
      .order("due_at", { ascending: true })
      .limit(1),
  ]);

  return NextResponse.json({
    recent: (recent ?? []).map((a) => ({
      type: a.type,
      subject: a.subject,
      snippet: a.body ? String(a.body).replace(/\s+/g, " ").slice(0, 80) : null,
      at: a.occurred_at,
    })),
    next: upcoming?.[0] ? { type: upcoming[0].type, subject: upcoming[0].subject, dueAt: upcoming[0].due_at } : null,
  });
}
