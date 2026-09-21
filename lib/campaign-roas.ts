import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * FIRST-PARTY deal attribution (TW-independent) — the one resolver behind the
 * campaign pages, the analytics overview, and lead-cost.
 *
 * For each deal we walk contact emails → web_visitor_links → web_touches and
 * take the canonical paid click (last paid touch):
 *   • Facebook — web_touches.campaign already IS the Meta campaign id.
 *   • Google   — web_touches carries a gclid but an often-unusable utm_campaign,
 *                so gclid → campaign resolves via google_click_map (click_view).
 * No paid click → the last touch's organic source (klaviyo, linktree…) so
 * "attributed but not paid" is still countable. No touches at all → null, and
 * callers may fall back to the legacy contact.attribution blob.
 */
export interface DealAttribution {
  channel: string | null; // paid channel slug, or null for organic
  campaignId: string | null; // "" = paid channel known, campaign unresolved
  source: string | null; // raw source of the attributed touch
}
export interface DealAttr {
  id: string;
  valueCents: number;
  at: string | null; // created (pd_add_time/created_at) for `created`, won_at for `won`
  contact: any; // raw crm_contacts row (emails, attribution) for callers' fallbacks
  attr: DealAttribution | null;
}
export interface AttributedDeals {
  created: DealAttr[];
  won: DealAttr[];
}
export interface CampaignRevenue {
  leads: number;
  wonDeals: number;
  wonValueCents: number;
}

async function pageAll(build: (from: number, to: number) => any): Promise<any[]> {
  const out: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

const emailsOf = (contact: any): string[] =>
  ((contact?.emails as any[]) ?? []).map((e) => (e?.value ?? "").trim().toLowerCase()).filter(Boolean);

/** Classify a web_touch as a paid click ({channel, campaignId}) or null. */
function classifyPaid(t: any, clickMap: Map<string, string>): { channel: string; campaignId: string | null } | null {
  const src = (t.source ?? "").toLowerCase();
  const isGoogle = !!t.gclid || !!t.gbraid || !!t.wbraid || src === "google";
  const isFacebook = !!t.fbclid || src === "facebook" || src === "instagram" || src === "meta";
  const numericCamp = t.campaign && /^\d{5,}$/.test(String(t.campaign)) ? String(t.campaign) : null;
  if (isGoogle) {
    const byClick = t.gclid ? clickMap.get(String(t.gclid)) : null;
    return { channel: "google", campaignId: byClick ?? numericCamp ?? null };
  }
  if (isFacebook) return { channel: "facebook", campaignId: numericCamp };
  return null;
}

// ── 10-minute cache: the resolver is the expensive part (deals + links + touches),
// and the overview/campaign pages call it twice when comparing periods.
const cache = new Map<string, { at: number; value: AttributedDeals }>();
const TTL_MS = 600_000;

export async function attributeDeals(db: SupabaseClient, startIso: string, endIso: string): Promise<AttributedDeals> {
  const key = `${startIso}|${endIso}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const [created, won] = await Promise.all([
    // "Created" = original Pipedrive add time when it exists; native deals
    // (post-PD-exit) have NO pd_add_time and must be bounded by created_at.
    pageAll((f, t) =>
      db
        .from("crm_deals")
        .select("id, pd_add_time, created_at, crm_contacts ( emails, attribution )")
        .or(
          `and(pd_add_time.gte.${startIso},pd_add_time.lte.${endIso}),` +
            `and(pd_add_time.is.null,created_at.gte.${startIso},created_at.lte.${endIso})`
        )
        .range(f, t)
    ),
    pageAll((f, t) =>
      db
        .from("crm_deals")
        .select("id, value_cents, won_at, crm_contacts ( emails, attribution )")
        .eq("status", "won")
        .gte("won_at", startIso)
        .lte("won_at", endIso)
        .range(f, t)
    ),
  ]);

  // Every email across both sets → visitor ids → touches.
  const allEmails = new Set<string>();
  for (const d of [...created, ...won]) for (const e of emailsOf((d as any).crm_contacts)) allEmails.add(e);
  const emailList = [...allEmails];

  const emailToVids = new Map<string, string[]>();
  const allVids = new Set<string>();
  for (let i = 0; i < emailList.length; i += 500) {
    const { data: links } = await db.from("web_visitor_links").select("email, visitor_id").in("email", emailList.slice(i, i + 500));
    for (const l of links ?? []) {
      const e = String(l.email).toLowerCase();
      (emailToVids.get(e) ?? emailToVids.set(e, []).get(e)!).push(l.visitor_id);
      allVids.add(l.visitor_id);
    }
  }

  const touchesByVid = new Map<string, any[]>();
  const gclids = new Set<string>();
  const vidList = [...allVids];
  for (let i = 0; i < vidList.length; i += 300) {
    const { data: touches } = await db
      .from("web_touches")
      .select("visitor_id, at, source, campaign, gclid, gbraid, wbraid, fbclid")
      .in("visitor_id", vidList.slice(i, i + 300));
    for (const t of touches ?? []) {
      (touchesByVid.get(t.visitor_id) ?? touchesByVid.set(t.visitor_id, []).get(t.visitor_id)!).push(t);
      if (t.gclid) gclids.add(String(t.gclid));
    }
  }

  const clickMap = new Map<string, string>();
  const gclidList = [...gclids];
  for (let i = 0; i < gclidList.length; i += 500) {
    const { data: rows } = await db.from("google_click_map").select("gclid, campaign_id").in("gclid", gclidList.slice(i, i + 500));
    for (const r of rows ?? []) if (r.campaign_id) clickMap.set(String(r.gclid), String(r.campaign_id));
  }

  const resolve = (contact: any): DealAttribution | null => {
    const touches: any[] = [];
    for (const e of emailsOf(contact)) for (const vid of emailToVids.get(e) ?? []) touches.push(...(touchesByVid.get(vid) ?? []));
    if (touches.length === 0) return null;
    touches.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")); // newest first
    for (const t of touches) {
      const paid = classifyPaid(t, clickMap);
      if (paid) return { channel: paid.channel, campaignId: paid.campaignId ?? "", source: t.source ?? paid.channel };
    }
    const organic = touches.find((t) => t.source);
    return organic ? { channel: null, campaignId: null, source: String(organic.source) } : null;
  };

  const value: AttributedDeals = {
    created: created.map((d: any) => ({
      id: d.id,
      valueCents: 0,
      at: d.pd_add_time ?? d.created_at ?? null,
      contact: d.crm_contacts,
      attr: resolve(d.crm_contacts),
    })),
    won: won.map((d: any) => ({
      id: d.id,
      valueCents: d.value_cents ?? 0,
      at: d.won_at ?? null,
      contact: d.crm_contacts,
      attr: resolve(d.crm_contacts),
    })),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Per-campaign rollup keyed `${channel}|${campaignId}` (paid channels only). */
export async function campaignRevenue(
  db: SupabaseClient,
  startIso: string,
  endIso: string
): Promise<Map<string, CampaignRevenue>> {
  const { created, won } = await attributeDeals(db, startIso, endIso);
  const out = new Map<string, CampaignRevenue>();
  const bump = (key: string, patch: Partial<CampaignRevenue>) => {
    const cur = out.get(key) ?? { leads: 0, wonDeals: 0, wonValueCents: 0 };
    cur.leads += patch.leads ?? 0;
    cur.wonDeals += patch.wonDeals ?? 0;
    cur.wonValueCents += patch.wonValueCents ?? 0;
    out.set(key, cur);
  };
  for (const d of created) if (d.attr?.channel) bump(`${d.attr.channel}|${d.attr.campaignId ?? ""}`, { leads: 1 });
  for (const d of won) if (d.attr?.channel) bump(`${d.attr.channel}|${d.attr.campaignId ?? ""}`, { wonDeals: 1, wonValueCents: d.valueCents });
  return out;
}
