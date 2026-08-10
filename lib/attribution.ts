import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Contact ad-attribution ingestion. Sources feed flat `attr_*` keys
 * (public/attr.js naming) from Shopify order note_attributes or Klaviyo
 * profile properties; we fold them into crm_contacts.attribution as
 * {first, last} touches. First touch is write-once (earliest wins);
 * last touch takes the newest attr_last_at.
 */

export type Touch = {
  source?: string; medium?: string; campaign?: string; content?: string; term?: string;
  gclid?: string; gbraid?: string; wbraid?: string; fbclid?: string; msclkid?: string; ttclid?: string;
  lp?: string; ref?: string; at?: string;
};

const CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid"] as const;
const UTM = ["source", "medium", "campaign", "content", "term"] as const;

/** Parse flat attr_* keys (from cart attributes / Klaviyo props) into touches. */
export function touchesFromFlat(flatIn: Record<string, unknown>): { first: Touch; last: Touch } | null {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(flatIn)) {
    if (k.startsWith("attr_") && typeof v === "string" && v.trim()) flat[k] = v.trim().slice(0, 300);
  }
  if (Object.keys(flat).length === 0) return null;
  const first: Touch = {}, last: Touch = {};
  for (const u of UTM) {
    if (flat[`attr_first_${u}`]) first[u] = flat[`attr_first_${u}`];
    if (flat[`attr_last_${u}`]) last[u] = flat[`attr_last_${u}`];
  }
  for (const c of CLICK_IDS) if (flat[`attr_${c}`]) last[c] = flat[`attr_${c}`];
  if (flat.attr_landing) first.lp = flat.attr_landing;
  if (flat.attr_referrer) first.ref = flat.attr_referrer;
  if (flat.attr_first_at) first.at = flat.attr_first_at;
  if (flat.attr_last_at) last.at = flat.attr_last_at;
  if (Object.keys(first).length === 0 && Object.keys(last).length === 0) return null;
  return { first, last };
}

/** Merge captured touches into a contact found by email. No-op when unmatched. */
export async function mergeContactAttribution(
  db: SupabaseClient,
  email: string | null | undefined,
  touches: { first: Touch; last: Touch } | null
): Promise<boolean> {
  if (!email || !touches) return false;
  const norm = email.trim().toLowerCase();
  if (!norm) return false;

  const { data: contact } = await db
    .from("crm_contacts")
    .select("id, attribution")
    .filter("emails", "cs", JSON.stringify([{ value: norm }]))
    .limit(1)
    .maybeSingle();
  if (!contact) return false;

  const cur = (contact.attribution ?? {}) as { first?: Touch; last?: Touch };
  const next = { ...cur } as { first?: Touch; last?: Touch; updated_at?: string };

  // First touch: earliest wins (never clobber an older first with a newer one).
  if (Object.keys(touches.first).length > 0) {
    if (!cur.first || (touches.first.at && cur.first.at && touches.first.at < cur.first.at)) {
      next.first = touches.first;
    }
  }
  // Last touch: newest wins.
  if (Object.keys(touches.last).length > 0) {
    if (!cur.last || !cur.last.at || !touches.last.at || touches.last.at >= cur.last.at) {
      next.last = touches.last;
    }
  }
  if (next.first === cur.first && next.last === cur.last) return false;
  next.updated_at = new Date().toISOString();

  await db.from("crm_contacts").update({ attribution: next }).eq("id", contact.id);
  return true;
}
