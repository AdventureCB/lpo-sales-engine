import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { envOptional } from "@/lib/env";
import { enqueuePdSync } from "@/lib/pd-sync";
import { mergeDeals } from "@/lib/pipedrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Merge one deal into another. `dupId` is absorbed into `survivorId`:
 * activities move over, value/interests are unioned onto the survivor, and
 * the duplicate is closed (status 'lost', reason "Merged into …") with notes
 * on both sides. For Pipedrive-linked deals we call PD's own merge so PD
 * stays consistent (it moves the PD activities too); native deals merge
 * purely in-app. Not reversible — the UI confirms first.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { dupId?: string; survivorId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { dupId, survivorId } = body;
  if (!dupId || !survivorId || dupId === survivorId)
    return NextResponse.json({ error: "distinct dupId and survivorId required" }, { status: 400 });

  const db = supabaseAdmin();
  const sel = "id, title, value_cents, interests, contact_id, pipedrive_deal_id, status, crm_stages(name)";
  const [{ data: dup }, { data: survivor }] = await Promise.all([
    db.from("crm_deals").select(sel).eq("id", dupId).maybeSingle(),
    db.from("crm_deals").select(sel).eq("id", survivorId).maybeSingle(),
  ]);
  if (!dup || !survivor) return NextResponse.json({ error: "deal not found" }, { status: 404 });

  const nowIso = new Date().toISOString();

  // 1) Move the duplicate's timeline onto the survivor.
  await db.from("crm_activities").update({ deal_id: survivorId }).eq("deal_id", dupId);

  // 2) Union interests; keep the survivor's value, else adopt the duplicate's.
  const interests = [
    ...new Set([...(((survivor as any).interests as string[]) ?? []), ...(((dup as any).interests as string[]) ?? [])]),
  ];
  await db
    .from("crm_deals")
    .update({
      interests,
      value_cents: (survivor as any).value_cents ?? (dup as any).value_cents ?? null,
      updated_at: nowIso,
    })
    .eq("id", survivorId);

  // 3) Notes on both sides for the audit trail.
  const dupStage = (dup as any).crm_stages?.name ?? "—";
  await db.from("crm_activities").insert([
    { deal_id: survivorId, contact_id: (survivor as any).contact_id, type: "note", actor: "system", subject: "🔗 Merged duplicate", body: `Absorbed "${(dup as any).title}" (was ${dupStage}). Its activities were moved here.` },
    { deal_id: dupId, contact_id: (dup as any).contact_id, type: "note", actor: "system", subject: "🔗 Merged", body: `Merged into "${(survivor as any).title}".` },
  ]);

  // 4) Close the duplicate.
  await db
    .from("crm_deals")
    .update({ status: "lost", lost_at: nowIso, lost_reason: `Merged into "${(survivor as any).title}"`, updated_at: nowIso })
    .eq("id", dupId);

  // 5) Recompute the survivor's last-activity from the combined timeline.
  await db.rpc("refresh_one_deal_last_activity", { p_deal: survivorId }).then(() => {}, () => {});

  // 6) Keep Pipedrive consistent.
  let pdNote: string | null = null;
  const hasToken = !!envOptional("PIPEDRIVE_API_TOKEN");
  const dupPd = (dup as any).pipedrive_deal_id as number | null;
  const survPd = (survivor as any).pipedrive_deal_id as number | null;
  if (hasToken && dupPd && survPd) {
    try {
      await mergeDeals(dupPd, survPd); // moves PD activities + marks dup merged
    } catch {
      // Fall back to marking the duplicate lost via the outbox.
      await enqueuePdSync(db, "deal_update", { dealId: dupPd, fields: { status: "lost" } });
      await enqueuePdSync(db, "note", { dealId: survPd, content: `🔗 Merged duplicate "${(dup as any).title}"` });
      pdNote = "Pipedrive merge deferred to the sync queue.";
    }
  } else if (hasToken && dupPd) {
    await enqueuePdSync(db, "deal_update", { dealId: dupPd, fields: { status: "lost" } });
  }

  return NextResponse.json({ ok: true, survivorId, pdNote });
}
