import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * FIRST-PARTY deal attribution (TW-independent) — the one resolver behind the
 * campaign pages, the analytics overview, and lead-cost.
 *
 * For each deal we walk contact emails → web_visitor_links → web_touches and
 * take the paid click that ORIGINATED the deal (last paid touch in the 30 days
 * before deal creation; survey deals default to Meta; Klaviyo-engine deals are
 * never paid — see resolve()). Won revenue follows the same origin.
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
  adId: string | null; // Meta: utm_content ad id on the click; Google: click_view map
  source: string | null; // raw source of the attributed touch
}
export interface DealAttr {
  id: string;
  valueCents: number;
  at: string | null; // created (pd_add_time/created_at) for `created`, won_at for `won`
  contact: any; // raw crm_contacts row (emails, attribution) for callers' fallbacks
  attr: DealAttribution | null; // ORIGIN (what made the deal exist)
  lastClick: DealAttribution | null; // most recent paid touch on record, any time (the old "lead")
}
export interface AttributedDeals {
  created: DealAttr[];
  won: DealAttr[];
}
export interface CampaignRevenue {
  leads: number;
  wonDeals: number;
  wonValueCents: number;
  lastClickLeads: number; // deals whose most recent paid touch (any time) is this campaign
  lastClickWonDeals: number;
  lastClickValueCents: number;
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

type ClickInfo = { campaignId: string; adId: string | null };

/**
 * Hand-typed Meta utm_campaign labels → campaign ids. Order: admin alias
 * (campaign_aliases) → unique campaign-name token match ("mof" ⊂ "MOF | Demo
 * Request | Leads" but not "MOFU | …"; "retargeting" matches several → null,
 * needs an alias).
 */
export interface FacebookLabelResolver {
  resolve: (label: string | null | undefined) => { campaignId: string; how: "alias" | "name" } | null;
  /** Typed utm_content ("dirt bags") → the one ad in that campaign whose name matches. */
  resolveAd: (campaignId: string, content: string | null | undefined) => string | null;
  campaigns: { id: string; name: string; active: boolean }[];
}
// Labels arrive URL-encoded when the ad used {{campaign.name}} ("mof+%7c+demo+request%7c+leads").
const tokens = (s: string) => {
  let t = s;
  try { t = decodeURIComponent(s.replace(/\+/g, " ")); } catch {}
  return t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
};
export async function buildFacebookLabelResolver(db: SupabaseClient): Promise<FacebookLabelResolver> {
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const [{ data: camps }, { data: aliases }, { data: ads }] = await Promise.all([
    db.rpc("facebook_campaigns"), // distinct in SQL — the daily table exceeds PostgREST's 1,000-row cap
    db.from("campaign_aliases").select("label, campaign_id").eq("channel", "facebook"),
    db.rpc("facebook_ads"),
  ]);
  const adsByCampaign = new Map<string, { id: string; set: Set<string> }[]>();
  for (const a of (ads ?? []) as any[]) {
    (adsByCampaign.get(String(a.campaign_id)) ?? adsByCampaign.set(String(a.campaign_id), []).get(String(a.campaign_id))!).push({ id: String(a.ad_id), set: new Set(tokens(String(a.name))) });
  }
  // Active (seen in the last 14 days) first, then the rest by name.
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const campaigns = ((camps ?? []) as any[])
    .filter((c) => c.campaign_id && c.name && String(c.last_day) >= since)
    .map((c) => ({ id: String(c.campaign_id), name: String(c.name), active: String(c.last_day) >= cutoff }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const tokenSets = campaigns.map((c) => ({ id: c.id, set: new Set(tokens(c.name)) }));
  const aliasMap = new Map((aliases ?? []).map((a: any) => [String(a.label).toLowerCase(), String(a.campaign_id)]));
  const cache = new Map<string, { campaignId: string; how: "alias" | "name" } | null>();
  return {
    campaigns,
    resolveAd(campaignId, content) {
      const want = tokens((content ?? "").trim());
      if (!want.length) return null;
      const hits = (adsByCampaign.get(campaignId) ?? []).filter((a) => want.every((w) => a.set.has(w)));
      return hits.length === 1 ? hits[0].id : null;
    },
    resolve(label) {
      const key = (label ?? "").trim().toLowerCase();
      if (!key) return null;
      if (cache.has(key)) return cache.get(key)!;
      let out: { campaignId: string; how: "alias" | "name" } | null = null;
      const alias = aliasMap.get(key);
      if (alias) out = { campaignId: alias, how: "alias" };
      else {
        const want = tokens(key);
        const hits = want.length ? tokenSets.filter((c) => want.every((w) => c.set.has(w))) : [];
        if (hits.length === 1) out = { campaignId: hits[0].id, how: "name" };
      }
      cache.set(key, out);
      return out;
    },
  };
}

/** Organic Meta traffic (page / bio links, Linktree) — Meta appends fbclid to these too, so they must be excluded explicitly. */
export function isOrganicSocialTouch(t: any): boolean {
  const med = String(t?.medium ?? "").toLowerCase();
  const src = String(t?.source ?? "").toLowerCase();
  const content = String(t?.content ?? "");
  const camp = String(t?.campaign ?? "").toLowerCase();
  return ["social", "organic", "bio", "link_in_bio", "referral"].includes(med) || src === "linktree"
    || /facebook_ua|link_in_bio|product_card/i.test(content) || camp === "meta_catalog" || camp === "openai_catalog";
}

/** Classify a web_touch as a paid click ({channel, campaignId, adId}) or null. */
function classifyPaid(
  t: any,
  clickMap: Map<string, ClickInfo>,
  adMap: Map<string, string> = new Map(),
  labels: FacebookLabelResolver | null = null
): { channel: string; campaignId: string | null; adId: string | null } | null {
  const src = (t.source ?? "").toLowerCase();
  if (isOrganicSocialTouch(t) && !t.gclid) return null;
  const isGoogle = !!t.gclid || !!t.gbraid || !!t.wbraid || src === "google";
  const isFacebook = !!t.fbclid || src === "facebook" || src === "instagram" || src === "meta";
  const numeric = (v: unknown) => (v && /^\d{5,}$/.test(String(v)) ? String(v) : null);
  const numericCamp = numeric(t.campaign);
  if (isGoogle) {
    const byClick = t.gclid ? clickMap.get(String(t.gclid)) : null;
    return { channel: "google", campaignId: byClick?.campaignId ?? numericCamp ?? null, adId: byClick?.adId ?? numeric(t.content) };
  }
  // Meta's URL template puts {{ad.id}} in utm_content (85% of clicks carry it).
  // When utm_campaign is a hand-typed label ("mof", "retargeting") the ad id
  // still resolves the campaign through the synced ad-level table.
  if (isFacebook) {
    const adId = numeric(t.content);
    const viaAd = adId ? adMap.get(adId) ?? null : null;
    const viaLabel = !numericCamp && !viaAd ? labels?.resolve(t.campaign)?.campaignId ?? null : null;
    const campaignId = numericCamp ?? viaAd ?? viaLabel;
    // Typed ad name in utm_content → ad id within the resolved campaign.
    const adByName = !adId && campaignId && t.content && labels ? labels.resolveAd(campaignId, t.content) : null;
    return { channel: "facebook", campaignId, adId: adId ?? adByName };
  }
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
        .select("id, pd_add_time, created_at, deal_sources ( name ), crm_contacts ( emails, attribution )")
        .or(
          `and(pd_add_time.gte.${startIso},pd_add_time.lte.${endIso}),` +
            `and(pd_add_time.is.null,created_at.gte.${startIso},created_at.lte.${endIso})`
        )
        .range(f, t)
    ),
    pageAll((f, t) =>
      db
        .from("crm_deals")
        .select("id, value_cents, won_at, pd_add_time, created_at, deal_sources ( name ), crm_contacts ( emails, attribution )")
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

  // `.in()` filters travel in the URL. Chunks are sized so the URL stays well
  // under the gateway limit (gclids are ~100 chars each; 500 of them silently
  // failed and left every Google deal "campaign unresolved" on long windows),
  // and every page error is thrown instead of ignored.
  const must = <T,>(r: { data: T | null; error: any }): T => {
    if (r.error) throw new Error(r.error.message ?? String(r.error));
    return (r.data ?? ([] as unknown as T)) as T;
  };
  const emailToVids = new Map<string, string[]>();
  const allVids = new Set<string>();
  for (let i = 0; i < emailList.length; i += 150) {
    const links = must<any[]>(await db.from("web_visitor_links").select("email, visitor_id").in("email", emailList.slice(i, i + 150)).limit(5000));
    for (const l of links) {
      const e = String(l.email).toLowerCase();
      (emailToVids.get(e) ?? emailToVids.set(e, []).get(e)!).push(l.visitor_id);
      allVids.add(l.visitor_id);
    }
  }

  const touchesByVid = new Map<string, any[]>();
  const gclids = new Set<string>();
  const vidList = [...allVids];
  for (let i = 0; i < vidList.length; i += 150) {
    const touches = must<any[]>(
      await db
        .from("web_touches")
        .select("visitor_id, at, source, campaign, content, gclid, gbraid, wbraid, fbclid")
        .in("visitor_id", vidList.slice(i, i + 150))
        .limit(5000)
    );
    for (const t of touches) {
      (touchesByVid.get(t.visitor_id) ?? touchesByVid.set(t.visitor_id, []).get(t.visitor_id)!).push(t);
      if (t.gclid) gclids.add(String(t.gclid));
    }
  }

  // Facebook ad id → campaign id (for touches whose utm_campaign isn't the id).
  const adMap = new Map<string, string>();
  {
    const adIds = new Set<string>();
    for (const list of touchesByVid.values()) for (const t of list) if (t.fbclid || /^(facebook|fb|meta|instagram|ig)$/i.test(t.source ?? "")) {
      if (t.content && /^\d{5,}$/.test(String(t.content)) && !/^\d{5,}$/.test(String(t.campaign ?? ""))) adIds.add(String(t.content));
    }
    const ids = [...adIds];
    if (ids.length) {
      const rows = must<any[]>(await db.rpc("facebook_ad_campaigns", { p_ad_ids: ids }));
      for (const r of rows) if (r.campaign_id) adMap.set(String(r.ad_id), String(r.campaign_id));
    }
  }

  const labels = await buildFacebookLabelResolver(db);

  const clickMap = new Map<string, ClickInfo>();
  const gclidList = [...gclids];
  for (let i = 0; i < gclidList.length; i += 60) {
    const rows = must<any[]>(
      await db.from("google_click_map").select("gclid, campaign_id, ad_id").in("gclid", gclidList.slice(i, i + 60)).limit(5000)
    );
    for (const r of rows) {
      if (r.campaign_id) clickMap.set(String(r.gclid), { campaignId: String(r.campaign_id), adId: r.ad_id ? String(r.ad_id) : null });
    }
  }

  // ORIGIN attribution (Kyle 10/1): a lead belongs to the paid source that
  // caused the deal to enter the CRM, judged at deal creation:
  //   • survey deals (Typeform: Survey West / Quote Survey / Survey East) can
  //     only come from an ad → Meta by definition; the survey's own hidden
  //     fields pick the campaign when present;
  //   • Klaviyo-driven engines (Hot List Import, CAI segments, Synchrony list)
  //     are email-originated → never a paid lead;
  //   • everything else (Saved Build, Abandoned Cart, calls, bookings…) = the
  //     last paid click in the LOOKBACK before creation, i.e. the click that
  //     brought them to the site. Older clicks don't count.
  // Won revenue uses the same origin, so leads/won/revenue describe one cohort.
  const LOOKBACK_MS = 30 * 86_400_000;
  const resolve = (contact: any, createdIso: string | null, sourceName: string | null): DealAttribution | null => {
    const src = (sourceName ?? "").toLowerCase();
    // Synchrony is NOT here: that Klaviyo form lives on a site page people
    // reach from Meta, Google or organically, so it follows the click rule.
    if (/hot list|\bcai\b/.test(src)) return { channel: null, campaignId: null, adId: null, source: sourceName };
    const touches: any[] = [];
    const created = createdIso ? Date.parse(createdIso) : null;
    const cutoff = created != null ? created + 3_600_000 : null; // 1h grace for beacon/CRM clock skew
    const floor = created != null ? created - LOOKBACK_MS : null;
    const inTime = (t: any) => {
      if (cutoff == null || !t?.at) return true;
      const at = Date.parse(String(t.at));
      return !(at > cutoff) && !(floor != null && at < floor);
    };
    for (const e of emailsOf(contact)) for (const vid of emailToVids.get(e) ?? []) touches.push(...(touchesByVid.get(vid) ?? []).filter(inTime));
    // Off-site captures live in the contact's attribution blob, not the site
    // beacon: Typeform survey hidden fields (utm_* / fbclid / gclid carried from
    // a Meta or Google ad straight into the survey — Quote Survey / Survey West
    // / Survey East leads never touch the website) plus Klaviyo/cart attr_*
    // props. Same shape as a web_touch (source, campaign, content = ad id,
    // click ids, at), so they join the same last-paid-click pick.
    const blob = (contact?.attribution ?? {}) as { first?: any; last?: any; touches?: any[] };
    for (const t of [...(blob.touches ?? []), blob.last, blob.first]) if (t && typeof t === "object" && inTime(t)) touches.push(t);
    const isSurvey = /survey/.test(src);
    touches.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? ""))); // newest first
    for (const t of touches) {
      const paid = classifyPaid(t, clickMap, adMap, labels);
      if (paid) return { channel: paid.channel, campaignId: paid.campaignId ?? "", adId: paid.adId, source: t.source ?? paid.channel };
    }
    // A survey deal with no click id on record is still a Meta lead — that's
    // the only way the survey is reached — just with the campaign unresolved.
    if (isSurvey) return { channel: "facebook", campaignId: "", adId: null, source: sourceName ?? "survey" };
    if (touches.length === 0) return null;
    const organic = touches.find((t) => t.source);
    return organic ? { channel: null, campaignId: null, adId: null, source: String(organic.source) } : null;
  };

  // LAST CLICK: the most recent paid touch on record, no time bound and no
  // source rules — the number the pages called "leads" before 10/1. Kept as a
  // side-by-side read of "most recent marketing touch".
  const resolveLastClick = (contact: any): DealAttribution | null => {
    const touches: any[] = [];
    for (const e of emailsOf(contact)) for (const vid of emailToVids.get(e) ?? []) touches.push(...(touchesByVid.get(vid) ?? []));
    const blob = (contact?.attribution ?? {}) as { first?: any; last?: any; touches?: any[] };
    for (const t of [...(blob.touches ?? []), blob.last, blob.first]) if (t && typeof t === "object") touches.push(t);
    touches.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
    for (const t of touches) {
      const paid = classifyPaid(t, clickMap, adMap, labels);
      if (paid) return { channel: paid.channel, campaignId: paid.campaignId ?? "", adId: paid.adId, source: t.source ?? paid.channel };
    }
    return null;
  };

  const value: AttributedDeals = {
    created: created.map((d: any) => ({
      id: d.id,
      valueCents: 0,
      at: d.pd_add_time ?? d.created_at ?? null,
      contact: d.crm_contacts,
      attr: resolve(d.crm_contacts, d.pd_add_time ?? d.created_at ?? null, d.deal_sources?.name ?? null),
      lastClick: resolveLastClick(d.crm_contacts),
    })),
    won: won.map((d: any) => ({
      id: d.id,
      valueCents: d.value_cents ?? 0,
      at: d.won_at ?? null,
      contact: d.crm_contacts,
      // revenue follows the lead's origin (judged at creation), not the last click before purchase
      attr: resolve(d.crm_contacts, d.pd_add_time ?? d.created_at ?? null, d.deal_sources?.name ?? null),
      lastClick: resolveLastClick(d.crm_contacts),
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
    const cur = out.get(key) ?? { leads: 0, wonDeals: 0, wonValueCents: 0, lastClickLeads: 0, lastClickWonDeals: 0, lastClickValueCents: 0 };
    cur.leads += patch.leads ?? 0;
    cur.wonDeals += patch.wonDeals ?? 0;
    cur.wonValueCents += patch.wonValueCents ?? 0;
    cur.lastClickLeads += patch.lastClickLeads ?? 0;
    cur.lastClickWonDeals += patch.lastClickWonDeals ?? 0;
    cur.lastClickValueCents += patch.lastClickValueCents ?? 0;
    out.set(key, cur);
  };
  const keyOf = (a: DealAttribution) => `${a.channel}|${a.campaignId ?? ""}`;
  for (const d of created) {
    if (d.attr?.channel) bump(keyOf(d.attr), { leads: 1 });
    if (d.lastClick?.channel) bump(keyOf(d.lastClick), { lastClickLeads: 1 });
  }
  for (const d of won) {
    if (d.attr?.channel) bump(keyOf(d.attr), { wonDeals: 1, wonValueCents: d.valueCents });
    if (d.lastClick?.channel) bump(keyOf(d.lastClick), { lastClickWonDeals: 1, lastClickValueCents: d.valueCents });
  }
  return out;
}
