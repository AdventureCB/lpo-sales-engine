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
      "id, rep_id, direction, status, started_at, answered_at, duration_s, classification, disposition, deal_id, crm_deal_id, raw"
    )
    .not("started_at", "is", null)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (missedOnly) q = q.eq("direction", "incoming").is("answered_at", null);
  const { data: calls, error } = await q;
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  const { data: reps } = await db.from("reps").select("id, name, telnyx_number");
  const repName = new Map((reps ?? []).map((r) => [r.id, r.name]));

  // Our own line numbers (last-10) — so we can pick the OTHER party as the peer.
  const last10 = (n: string | null | undefined) => (n ?? "").replace(/\D/g, "").slice(-10);
  const ours = new Set((reps ?? []).map((r) => last10(r.telnyx_number)).filter((x) => x.length === 10));
  ours.add("5093001277"); // shared Customer Service line

  // The customer's number: the participant that isn't one of ours. Outbound
  // participants are [our_number, dialed] — participants[0] was wrongly shown.
  // Fall back to direction if the set can't disambiguate.
  const peerOf = (raw: any, direction: string | null): string | null => {
    const parts: string[] = raw?.data?.object?.participants ?? [];
    if (Array.isArray(parts) && parts.length) {
      const other = parts.find((p) => !ours.has(last10(p)));
      if (other) return other;
      return direction === "incoming" ? parts[0] : parts[parts.length - 1];
    }
    // Quo / non-participants shape.
    return direction === "incoming" ? (raw?.payload?.from ?? null) : (raw?.payload?.to ?? null);
  };

  const phones = [...new Set((calls ?? []).map((c) => peerOf(c.raw, c.direction)).filter(Boolean))] as string[];
  const contactByPhone = new Map<string, any>();
  if (phones.length > 0) {
    const { data: resolved } = await db.rpc("contacts_by_phones", { p_phones: phones });
    for (const r of resolved ?? []) contactByPhone.set(r.phone, r);
  }

  // Resolve the call's OWN linked deal (definitive) → id + title.
  const ownDealIds = [...new Set((calls ?? []).map((c) => c.crm_deal_id).filter(Boolean))] as string[];
  const dealTitleById = new Map<string, string>();
  if (ownDealIds.length) {
    const { data: ds } = await db.from("crm_deals").select("id, title").in("id", ownDealIds);
    for (const d of ds ?? []) dealTitleById.set(d.id, d.title);
  }

  const entries = (calls ?? []).map((c) => {
    const peer = peerOf(c.raw, c.direction);
    const contact = peer ? contactByPhone.get(peer) : null;
    // Prefer the call's own linked deal; else the peer's current open/active deal.
    const dealId = c.crm_deal_id ?? contact?.crm_deal_id ?? null;
    const dealTitle = (c.crm_deal_id && dealTitleById.get(c.crm_deal_id)) || contact?.deal_title || null;
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
      crmDealId: dealId,
      dealTitle,
      disposition: c.disposition,
      classification: c.classification,
      quality: (c.raw as any)?.client_quality ?? null,
      hasTranscript: Boolean((c.raw as any)?.transcript),
      // Voicemail playback + inline transcript — the call log must stand on
      // its own for calls with no linked deal (no timeline to fall back to).
      vm: Boolean((c.raw as any)?.vm) || c.classification === "voicemail",
      vmUrl: ((c.raw as any)?.vm_mp3 as string | undefined) ?? null,
      transcript: (c.raw as any)?.transcript ? String((c.raw as any).transcript).slice(0, 4000) : null,
    };
  });

  return NextResponse.json({ calls: entries });
}
