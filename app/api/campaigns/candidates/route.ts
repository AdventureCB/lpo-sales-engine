import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { stateTriggerCandidates } from "@/lib/campaigns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deals the campaign's auto-enroll trigger would enroll right now — the
 * builder's "test on someone who'd actually receive this" picker. Takes the
 * builder's CURRENT (possibly unsaved) trigger/settings so edits preview live.
 * POST { campaignId?, channel, trigger, settings, q? } → { total, deals: [{id, title, sender}] }
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const body = await req.json().catch(() => ({} as any));
  if (body?.trigger?.type !== "state") return NextResponse.json({ total: 0, deals: [], note: "manual campaign — no auto-enroll audience" });
  const db = supabaseAdmin();
  const ids = await stateTriggerCandidates(db, { id: body.campaignId ?? "00000000-0000-0000-0000-000000000000", channel: body.channel === "sms" ? "sms" : "email", trigger: body.trigger, settings: body.settings ?? {} } as any, 500);
  if (!ids.length) return NextResponse.json({ total: 0, deals: [] });
  const { data: deals } = await db.from("crm_deals").select("id, title, owner_email, owner_pipedrive_id").in("id", ids.slice(0, 500));
  const { data: cos } = await db.from("crm_reprospect_checkouts").select("deal_id, rep_email").in("deal_id", ids.slice(0, 500)).is("released_at", null).gt("expires_at", new Date().toISOString());
  const coRep = new Map((cos ?? []).map((c: any) => [c.deal_id, c.rep_email as string]));
  // Sender per deal in one pass (was one query per deal).
  const pdIds = [...new Set((deals ?? []).map((d: any) => d.owner_pipedrive_id).filter((x: any) => x != null))];
  const { data: reps } = pdIds.length ? await db.from("reps").select("email, pipedrive_user_id").in("pipedrive_user_id", pdIds) : { data: [] as any[] };
  const repByPd = new Map((reps ?? []).map((r: any) => [r.pipedrive_user_id, r.email as string]));
  const out: { id: string; title: string; sender: string }[] = [];
  for (const d of (deals ?? []) as any[]) {
    const sender = d.owner_email ?? (d.owner_pipedrive_id != null ? repByPd.get(d.owner_pipedrive_id) : null) ?? coRep.get(d.id) ?? null;
    if (!sender) continue; // enrollDeals would reject: nobody to send from
    out.push({ id: d.id, title: d.title, sender });
  }
  // Whole audience (≤500) — the picker filters client-side as you type.
  return NextResponse.json({ total: out.length, deals: out });
}
