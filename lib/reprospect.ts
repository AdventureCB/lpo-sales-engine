import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueuePdSync } from "./pd-sync";

export type ReprospectEvent = "conversation" | "scheduled" | "lost";

/**
 * Resolve an active reprospecting checkout when a rep acts on the deal.
 *   conversation → end the 3-day hold (deal stays Cainen; lock released)
 *   lost         → end the hold (deal is closed elsewhere in the flow)
 *   scheduled    → RECLAIM: flip owner Cainen→rep, then end the hold
 * No-op (returns null) when the deal isn't an active reprospect checkout, so
 * it's safe to call unconditionally from any disposition/schedule/lost path.
 */
export async function resolveReprospect(
  db: SupabaseClient,
  args: { crmDealId: string; repEmail: string; repPipedriveId: number | null; event: ReprospectEvent }
): Promise<ReprospectEvent | null> {
  const { data: co } = await db
    .from("crm_reprospect_checkouts")
    .select("id")
    .eq("deal_id", args.crmDealId)
    .is("released_at", null)
    .maybeSingle();
  if (!co) return null;

  // Reclaim on a scheduled activity: owner Cainen → rep (write through to PD).
  if (args.event === "scheduled" && args.repPipedriveId) {
    const { data: deal } = await db
      .from("crm_deals")
      .select("id, pipedrive_deal_id")
      .eq("id", args.crmDealId)
      .maybeSingle();
    if (deal) {
      await db
        .from("crm_deals")
        .update({ owner_pipedrive_id: args.repPipedriveId, owner_email: args.repEmail, updated_at: new Date().toISOString() })
        .eq("id", deal.id);
      if (deal.pipedrive_deal_id) {
        await enqueuePdSync(db, "deal_update", { dealId: deal.pipedrive_deal_id, fields: { owner_id: args.repPipedriveId } });
      }
      await db.from("crm_activities").insert({
        deal_id: deal.id,
        type: "system",
        subject: `Reclaimed from reprospecting pool by ${args.repEmail.split("@")[0]}`,
        actor: args.repEmail,
      });
    }
  }

  await db
    .from("crm_reprospect_checkouts")
    .update({ released_at: new Date().toISOString(), release_reason: args.event })
    .eq("id", co.id);
  return args.event;
}

/** Release every checkout whose 3-day hold has lapsed, back into the pool. */
export async function sweepExpiredCheckouts(db: SupabaseClient): Promise<number> {
  const { data } = await db
    .from("crm_reprospect_checkouts")
    .update({ released_at: new Date().toISOString(), release_reason: "expired" })
    .is("released_at", null)
    .lt("expires_at", new Date().toISOString())
    .select("id");
  return (data ?? []).length;
}
