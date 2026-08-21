import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Record a dial attempt the moment the rep hits Dial. Drives the shared
 * pool's 2-day cooldown and round-fairness (and is useful attempt data for
 * every queue).
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { dealId?: number; sprintId?: string; crmDealId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  // Native deals have no Pipedrive id — the sprint stamp below must still
  // happen for them (a null-dealId attempt used to 400 here, so dialed native
  // deals reappeared on every list reload).
  if (!body.dealId && !(body.sprintId && body.crmDealId)) {
    return NextResponse.json({ error: "dealId or sprintId+crmDealId required" }, { status: 400 });
  }

  const db = supabaseAdmin();
  // dial_attempts is PD-keyed — only recordable when a Pipedrive id exists.
  if (body.dealId) {
    const { error } = await db.from("dial_attempts").insert({
      deal_id: body.dealId,
      actor: user.email,
      rep_id: user.repId,
    });
    if (error) {
      console.error("attempt insert failed", error);
      return NextResponse.json({ error: "db error" }, { status: 500 });
    }
  }
  // Sprint session: mark the item called so it drops from the sprint queue.
  if (body.sprintId && body.crmDealId) {
    await db
      .from("crm_sprint_items")
      .update({ called_at: new Date().toISOString() })
      .eq("sprint_id", body.sprintId)
      .eq("deal_id", body.crmDealId);
  }
  return NextResponse.json({ ok: true });
}
