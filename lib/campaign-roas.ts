import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-campaign revenue attribution from FIRST-PARTY data (TW-independent).
 *
 * For each deal we walk contact emails → web_visitor_links → web_touches, pick
 * the canonical paid click (last paid touch), and resolve its campaign:
 *   • Facebook — web_touches.campaign already IS the Meta campaign id.
 *   • Google   — web_touches carries a gclid but an often-unusable utm_campaign,
 *                so we resolve gclid → campaign via google_click_map (click_view).
 * Channel-known but campaign-unresolved revenue is bucketed under campaignId ""
 * so it's never silently dropped.
 *
 * Returns a map keyed `${channel}|${campaignId}` → attributed leads (deals
 * created in-window) + won deals + won value.
 */
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

/** Classify a web_touch into {channel, campaignId|null}; null channel = not paid. */
function classifyTouch(t: any, clickMap: Map<string, string>): { channel: string; campaignId: string | null } | null {
  const src = (t.source ?? "").toLowerCase();
  const isGoogle = !!t.gclid || !!t.gbraid || !!t.wbraid || src === "google";
  const isFacebook = !!t.fbclid || src === "facebook" || src === "instagram" || src === "meta";
  if (isGoogle) {
    const byClick = t.gclid ? clickMap.get(String(t.gclid)) : null;
    // Fall back to utm_campaign only when it looks like a real campaign id (all digits).
    const utm = t.campaign && /^\d{5,}$/.test(String(t.campaign)) ? String(t.campaign) : null;
    return { channel: "google", campaignId: byClick ?? utm ?? null };
  }
  if (isFacebook) {
    const camp = t.campaign && /^\d{5,}$/.test(String(t.campaign)) ? String(t.campaign) : null;
    return { channel: "facebook", campaignId: camp };
  }
  return null;
}

export async function campaignRevenue(
  db: SupabaseClient,
  startIso: string,
  endIso: string
): Promise<Map<string, CampaignRevenue>> {
  const [created, won] = await Promise.all([
    pageAll((f, t) =>
      db
        .from("crm_deals")
        .select("id, pd_add_time, created_at, crm_contacts ( emails )")
        .or(`pd_add_time.gte.${startIso},and(pd_add_time.is.null,created_at.gte.${startIso})`)
        .lte("pd_add_time", endIso)
        .range(f, t)
    ),
    pageAll((f, t) =>
      db
        .from("crm_deals")
        .select("id, value_cents, won_at, crm_contacts ( emails )")
        .eq("status", "won")
        .gte("won_at", startIso)
        .lte("won_at", endIso)
        .range(f, t)
    ),
  ]);

  // Collect every email across both deal sets, resolve visitor ids, load touches.
  const allEmails = new Set<string>();
  for (const d of [...created, ...won]) for (const e of emailsOf((d as any).crm_contacts)) allEmails.add(e);
  const emailList = [...allEmails];

  const emailToVids = new Map<string, string[]>();
  const allVids = new Set<string>();
  for (let i = 0; i < emailList.length; i += 500) {
    const chunk = emailList.slice(i, i + 500);
    const { data: links } = await db.from("web_visitor_links").select("email, visitor_id").in("email", chunk);
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
    const chunk = vidList.slice(i, i + 300);
    const { data: touches } = await db
      .from("web_touches")
      .select("visitor_id, at, source, campaign, gclid, gbraid, wbraid, fbclid")
      .in("visitor_id", chunk);
    for (const t of touches ?? []) {
      (touchesByVid.get(t.visitor_id) ?? touchesByVid.set(t.visitor_id, []).get(t.visitor_id)!).push(t);
      if (t.gclid) gclids.add(String(t.gclid));
    }
  }

  // gclid → campaign id (Google click_view map).
  const clickMap = new Map<string, string>();
  const gclidList = [...gclids];
  for (let i = 0; i < gclidList.length; i += 500) {
    const chunk = gclidList.slice(i, i + 500);
    const { data: rows } = await db.from("google_click_map").select("gclid, campaign_id").in("gclid", chunk);
    for (const r of rows ?? []) if (r.campaign_id) clickMap.set(String(r.gclid), String(r.campaign_id));
  }

  // Resolve a deal's attributed campaign = its last PAID click.
  const attribute = (contact: any): { channel: string; campaignId: string } | null => {
    const touches: any[] = [];
    for (const e of emailsOf(contact)) for (const vid of emailToVids.get(e) ?? []) touches.push(...(touchesByVid.get(vid) ?? []));
    if (touches.length === 0) return null;
    touches.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")); // newest first
    for (const t of touches) {
      const c = classifyTouch(t, clickMap);
      if (c) return { channel: c.channel, campaignId: c.campaignId ?? "" };
    }
    return null;
  };

  const out = new Map<string, CampaignRevenue>();
  const bump = (key: string, patch: Partial<CampaignRevenue>) => {
    const cur = out.get(key) ?? { leads: 0, wonDeals: 0, wonValueCents: 0 };
    cur.leads += patch.leads ?? 0;
    cur.wonDeals += patch.wonDeals ?? 0;
    cur.wonValueCents += patch.wonValueCents ?? 0;
    out.set(key, cur);
  };
  for (const d of created) {
    const a = attribute((d as any).crm_contacts);
    if (a) bump(`${a.channel}|${a.campaignId}`, { leads: 1 });
  }
  for (const d of won) {
    const a = attribute((d as any).crm_contacts);
    if (a) bump(`${a.channel}|${a.campaignId}`, { wonDeals: 1, wonValueCents: (d as any).value_cents ?? 0 });
  }
  return out;
}
