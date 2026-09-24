import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { enrollDeals, type Campaign } from "@/lib/campaigns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enroll deals (bulk from CRM / sprint lists, or one from a deal page).
 *   POST { campaignId, dealIds: [] }         → per-deal ok/reason
 *   POST { dealId, stop: true }              → stop this deal's active campaign(s)
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { campaignId?: string; dealIds?: string[]; dealId?: string; stop?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();

  if (body.stop && body.dealId) {
    const { data: enrs } = await db.from("campaign_enrollments").select("id, campaign_id, campaigns ( name )").eq("deal_id", body.dealId).eq("status", "active");
    for (const e of (enrs ?? []) as any[]) {
      await db.from("campaign_enrollments").update({ status: "exited", exited_at: new Date().toISOString(), exit_reason: `stopped by ${user.email.split("@")[0]}` }).eq("id", e.id);
      await db.from("campaign_sends").update({ status: "skipped", error: "campaign stopped" }).eq("enrollment_id", e.id).in("status", ["draft", "approved"]);
      await db.from("crm_activities").insert({ deal_id: body.dealId, type: "system", subject: `📣 Campaign "${e.campaigns?.name ?? ""}" stopped`, actor: user.email, occurred_at: new Date().toISOString(), meta: { campaign_id: e.campaign_id } });
    }
    return NextResponse.json({ ok: true, stopped: enrs?.length ?? 0 });
  }

  const dealIds = [...new Set((body.dealIds ?? []).concat(body.dealId ? [body.dealId] : []))].filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 500);
  if (!body.campaignId || !dealIds.length) return NextResponse.json({ error: "campaignId and dealIds required" }, { status: 400 });
  const { data: camp } = await db.from("campaigns").select("*").eq("id", body.campaignId).maybeSingle();
  if (!camp) return NextResponse.json({ error: "campaign not found" }, { status: 404 });
  if (camp.status !== "active") return NextResponse.json({ error: "Campaign isn't active — activate it in the builder first." }, { status: 400 });
  if (user.role !== "admin" && !camp.shared && camp.owner_email !== user.email) return NextResponse.json({ error: "not your campaign" }, { status: 403 });
  const results = await enrollDeals(db, camp as Campaign, dealIds, user.email);
  const enrolled = results.filter((r) => r.ok).length;
  const reasons: Record<string, number> = {};
  for (const r of results) if (!r.ok && r.reason) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  return NextResponse.json({ ok: true, enrolled, skipped: results.length - enrolled, reasons, results });
}
