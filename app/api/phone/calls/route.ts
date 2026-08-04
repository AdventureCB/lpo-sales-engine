import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Call log: recent calls (both providers), with CRM contact/deal resolution. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const missedOnly = url.searchParams.get("missed") === "1";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 200);

  const db = supabaseAdmin();
  let q = db
    .from("call_events")
    .select(
      "id, rep_id, direction, status, started_at, answered_at, duration_s, classification, disposition, deal_id, raw"
    )
    .not("started_at", "is", null)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (missedOnly) q = q.eq("direction", "incoming").is("answered_at", null);
  const { data: calls, error } = await q;
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  const { data: reps } = await db.from("reps").select("id, name");
  const repName = new Map((reps ?? []).map((r) => [r.id, r.name]));

  const peerOf = (raw: any): string | null =>
    raw?.data?.object?.participants?.[0] ?? raw?.payload?.from ?? null;

  const phones = [...new Set((calls ?? []).map((c) => peerOf(c.raw)).filter(Boolean))] as string[];
  const contactByPhone = new Map<string, any>();
  if (phones.length > 0) {
    const { data: resolved } = await db.rpc("contacts_by_phones", { p_phones: phones });
    for (const r of resolved ?? []) contactByPhone.set(r.phone, r);
  }

  const entries = (calls ?? []).map((c) => {
    const peer = peerOf(c.raw);
    const contact = peer ? contactByPhone.get(peer) : null;
    const missed = c.direction === "incoming" && !c.answered_at;
    return {
      id: c.id,
      at: c.started_at,
      direction: c.direction,
      status: c.status,
      missed,
      durationS: c.duration_s,
      rep: c.rep_id ? repName.get(c.rep_id) ?? null : null,
      peer,
      contactName: contact?.contact_name ?? null,
      crmDealId: contact?.crm_deal_id ?? null,
      dealTitle: contact?.deal_title ?? null,
      disposition: c.disposition,
      classification: c.classification,
      quality: (c.raw as any)?.client_quality ?? null,
      hasTranscript: Boolean((c.raw as any)?.transcript),
    };
  });

  return NextResponse.json({ calls: entries });
}
