import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Which contact + deal an inbound caller's number belongs to.
 *
 * More than one contact can carry the same number (duplicate leads from two
 * engines — "Tanner " on a Survey West deal and "Tanner Mangum" on a Saved
 * Build deal, 11/9). The old lookup used maybeSingle(), which returns nothing
 * when two rows match, so those calls were stored with NO deal and never
 * showed on either timeline. Pick the best instead:
 *   1. an open deal owned by the rep who took the call
 *   2. any open deal, most recently updated first
 *   3. any deal, most recently updated first
 * DNC is true if ANY matching contact is DNC (the person asked not to be
 * contacted, whichever record says so).
 */
/**
 * Safety net (hourly reconcile): inbound Telnyx calls stored without a deal
 * get another resolution pass — the contact may have been created after the
 * call, or the webhook lookup hit the duplicate-contact case above.
 */
export async function relinkUnlinkedInboundCalls(db: SupabaseClient, lookbackHours = 72): Promise<{ checked: number; linked: number }> {
  const since = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();
  const { data: ours } = await db.from("reps").select("telnyx_number, quo_phone_number");
  const ourNumbers = new Set<string>((ours ?? []).flatMap((r: any) => [r.telnyx_number, r.quo_phone_number]).filter(Boolean));
  const { data: calls } = await db
    .from("call_events")
    .select("id, rep_id, raw")
    .eq("direction", "incoming")
    .is("crm_deal_id", null)
    .gte("started_at", since)
    .limit(200);
  let linked = 0;
  for (const c of (calls ?? []) as any[]) {
    const parts: string[] = c.raw?.data?.object?.participants ?? c.raw?.participants ?? [];
    const peer = parts.find((p) => p && !ourNumbers.has(p));
    if (!peer) continue;
    const hit = await resolveCallerDeal(db, peer, c.rep_id ?? null);
    if (!hit?.dealId) continue;
    await db.from("call_events").update({ crm_deal_id: hit.dealId, ...(hit.pipedriveDealId ? { deal_id: hit.pipedriveDealId } : {}) }).eq("id", c.id).is("crm_deal_id", null);
    linked++;
  }
  return { checked: calls?.length ?? 0, linked };
}

export async function resolveCallerDeal(
  db: SupabaseClient,
  peerE164: string,
  repId: string | null
): Promise<{ contactId: string; dnc: boolean; dealId: string | null; pipedriveDealId: number | null } | null> {
  const { data: contacts } = await db
    .from("crm_contacts")
    .select("id, dnc")
    .contains("phones", JSON.stringify([{ e164: peerE164 }]))
    .limit(10);
  if (!contacts?.length) return null;
  const ids = contacts.map((c) => c.id);
  const dnc = contacts.some((c) => Boolean((c as any).dnc));

  let repPd: number | null = null;
  if (repId) {
    const { data: rep } = await db.from("reps").select("pipedrive_user_id").eq("id", repId).maybeSingle();
    repPd = rep?.pipedrive_user_id ?? null;
  }
  const { data: deals } = await db
    .from("crm_deals")
    .select("id, contact_id, pipedrive_deal_id, status, owner_pipedrive_id, updated_at")
    .in("contact_id", ids)
    .order("updated_at", { ascending: false })
    .limit(20);
  const rank = (d: any) => (d.status === "open" ? (repPd != null && d.owner_pipedrive_id === repPd ? 0 : 1) : 2);
  const best = (deals ?? []).slice().sort((a: any, b: any) => rank(a) - rank(b) || String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  return {
    contactId: best?.contact_id ?? contacts[0].id,
    dnc,
    dealId: best?.id ?? null,
    pipedriveDealId: best?.pipedrive_deal_id ?? null,
  };
}
