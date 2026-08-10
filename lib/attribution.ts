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
export function touchesFromFlat(
  flatIn: Record<string, unknown>
): { first: Touch; last: Touch; touches?: Touch[] } | null {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(flatIn)) {
    if (!k.startsWith("attr_") || typeof v !== "string" || !v.trim()) continue;
    flat[k] = v.trim().slice(0, k === "attr_touches" ? 5000 : 300);
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

  // Multi-touch history: attr.js compact encoding {at,s,m,c,n,t,g,f,ms,tt}.
  let touches: Touch[] | undefined;
  if (flat.attr_touches) {
    try {
      const arr = JSON.parse(flat.attr_touches);
      if (Array.isArray(arr)) {
        touches = arr
          .filter((o) => o && typeof o === "object" && o.at)
          .slice(-40)
          .map((o: any): Touch => ({
            at: String(o.at).slice(0, 40),
            ...(o.s ? { source: String(o.s).slice(0, 100) } : {}),
            ...(o.m ? { medium: String(o.m).slice(0, 100) } : {}),
            ...(o.c ? { campaign: String(o.c).slice(0, 150) } : {}),
            ...(o.n ? { content: String(o.n).slice(0, 150) } : {}),
            ...(o.t ? { term: String(o.t).slice(0, 100) } : {}),
            ...(o.g ? { gclid: "1" } : {}),
            ...(o.f ? { fbclid: "1" } : {}),
            ...(o.ms ? { msclkid: "1" } : {}),
            ...(o.tt ? { ttclid: "1" } : {}),
          }));
        if (touches.length === 0) touches = undefined;
      }
    } catch {}
  }

  if (Object.keys(first).length === 0 && Object.keys(last).length === 0 && !touches) return null;
  return { first, last, touches };
}

/**
 * Link a visitor id (attr_vid pointer carried by an identity event) to an
 * email so the visitor's beaconed touch history joins the contact's journey.
 */
export async function linkVisitor(
  db: SupabaseClient,
  flatIn: Record<string, unknown>,
  email: string | null | undefined
): Promise<boolean> {
  const vid = typeof flatIn.attr_vid === "string" ? flatIn.attr_vid.trim().slice(0, 64) : null;
  const norm = email?.trim().toLowerCase();
  if (!vid || !norm || !/^[a-f0-9-]{16,64}$/i.test(vid)) return false;
  const { error } = await db
    .from("web_visitor_links")
    .upsert({ visitor_id: vid, email: norm, linked_at: new Date().toISOString() }, { onConflict: "visitor_id" });
  return !error;
}

/** Merge captured touches into a contact found by email. No-op when unmatched. */
export async function mergeContactAttribution(
  db: SupabaseClient,
  email: string | null | undefined,
  touches: { first: Touch; last: Touch; touches?: Touch[] } | null
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

  const cur = (contact.attribution ?? {}) as { first?: Touch; last?: Touch; touches?: Touch[] };
  const next = { ...cur } as { first?: Touch; last?: Touch; touches?: Touch[]; updated_at?: string };

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
  // Touch history: union by timestamp+source, chronological, capped.
  if (touches.touches?.length) {
    const byKey = new Map<string, Touch>();
    for (const t of [...(cur.touches ?? []), ...touches.touches]) {
      if (!t?.at) continue;
      byKey.set(`${t.at}|${t.source ?? ""}`, t);
    }
    const merged = [...byKey.values()].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "")).slice(-40);
    if (JSON.stringify(merged) !== JSON.stringify(cur.touches ?? [])) next.touches = merged;
  }

  if (next.first === cur.first && next.last === cur.last && next.touches === cur.touches) return false;
  next.updated_at = new Date().toISOString();

  await db.from("crm_contacts").update({ attribution: next }).eq("id", contact.id);
  return true;
}
