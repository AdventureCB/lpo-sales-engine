import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Lead cost per deal (ad attribution phase 3).
 *
 * Channel granularity by design: TW's public API exposes spend per channel,
 * campaign IDs per order — so a deal's lead cost = its channel's rolling
 * CPL (spend ÷ channel-attributed new deals). Blended CAC (spend ÷ ALL new
 * deals) is always computed beside it: attributed coverage is ~40-70%, and
 * the two tiers must never be silently blended.
 */

export interface ChannelStat {
  channel: string;
  spendCents: number;
  leads: number; // new deals attributed to this channel in the window
  cplCents: number | null;
  wonDeals: number;
  wonValueCents: number;
  costPerWonCents: number | null;
}

export interface LeadCostReport {
  days: number;
  channels: ChannelStat[];
  totals: {
    spendCents: number;
    newDeals: number;
    attributedDeals: number;
    blendedCacCents: number | null;
    wonDeals: number;
    wonValueCents: number;
  };
  organicSources: Record<string, number>; // attributed but non-paid (klaviyo, linktree…)
}

/** Normalize a raw attribution source (TW source or utm_source) to an ad_spend channel. */
export function normalizeChannel(source: string | null | undefined): string | null {
  if (!source) return null;
  const s = source.toLowerCase().trim();
  if (/^(google|google-ads|adwords|gads|googleads|google_ads)$/.test(s)) return "google";
  if (/^(facebook|facebook-ads|fb|meta|instagram|ig|fb-ads|meta-ads)$/.test(s)) return "facebook";
  if (/^(openai|openai-ads|chatgpt|chatgpt-ads)$/.test(s)) return "chatgpt";
  if (/^(bing|microsoft|msads|microsoft-ads)$/.test(s)) return "microsoft";
  if (/^(tiktok|tiktok-ads)$/.test(s)) return "tiktok";
  if (/^(pinterest|pinterest-ads)$/.test(s)) return "pinterest";
  if (/^(snapchat|snapchat-ads)$/.test(s)) return "snapchat";
  if (/^(reddit|reddit-ads)$/.test(s)) return "reddit";
  if (/^(linkedin|linkedin-ads)$/.test(s)) return "linkedin";
  if (/^(twitter|twitter-ads|x)$/.test(s)) return "twitter";
  return null; // organic / owned / unknown (klaviyo, youtube organic, linktree…)
}

/** A contact's display source + paid channel, from its attribution blob. */
export function contactAdInfo(attribution: any): { source: string | null; campaign: string | null; channel: string | null } {
  const a = attribution ?? {};
  const source: string | null = a.tw?.source ?? a.last?.source ?? a.first?.source ?? null;
  const campaign: string | null = a.tw?.campaign_id || a.last?.campaign || a.first?.campaign || null;
  const channel =
    normalizeChannel(a.tw?.source) ??
    normalizeChannel(a.last?.source) ??
    normalizeChannel(a.first?.source) ??
    normalizeChannel(a.tw?.first_source);
  return { source, campaign, channel };
}

async function fetchAll(build: (from: number, to: number) => any): Promise<any[]> {
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

export async function computeLeadCost(db: SupabaseClient, days: number): Promise<LeadCostReport> {
  const startIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const startDay = startIso.slice(0, 10);

  const [spendRows, created, won] = await Promise.all([
    fetchAll((f, t) => db.from("ad_spend").select("day, channel, spend_cents").gte("day", startDay).range(f, t)),
    // "Created" = original Pipedrive add time — mirror created_at reflects
    // import batches, not real deal creation (blended CAC would be garbage).
    fetchAll((f, t) =>
      db
        .from("crm_deals")
        .select("id, contact_id, pd_add_time, created_at, crm_contacts ( attribution )")
        .or(`pd_add_time.gte.${startIso},and(pd_add_time.is.null,created_at.gte.${startIso})`)
        .range(f, t)
    ),
    fetchAll((f, t) =>
      db
        .from("crm_deals")
        .select("id, value_cents, crm_contacts ( attribution )")
        .eq("status", "won")
        .gte("won_at", startIso)
        .range(f, t)
    ),
  ]);

  const spendByChannel = new Map<string, number>();
  for (const r of spendRows) {
    spendByChannel.set(r.channel, (spendByChannel.get(r.channel) ?? 0) + (r.spend_cents ?? 0));
  }

  const leadsByChannel = new Map<string, number>();
  const organicSources: Record<string, number> = {};
  let attributedDeals = 0;
  for (const d of created) {
    const attr = (d as any).crm_contacts?.attribution;
    if (!attr) continue;
    const { source, channel } = contactAdInfo(attr);
    if (channel) {
      attributedDeals++;
      leadsByChannel.set(channel, (leadsByChannel.get(channel) ?? 0) + 1);
    } else if (source) {
      attributedDeals++;
      const key = source.slice(0, 40);
      organicSources[key] = (organicSources[key] ?? 0) + 1;
    }
  }

  const wonByChannel = new Map<string, { n: number; value: number }>();
  let wonTotal = 0, wonValueTotal = 0;
  for (const d of won) {
    wonTotal++;
    wonValueTotal += (d as any).value_cents ?? 0;
    const { channel } = contactAdInfo((d as any).crm_contacts?.attribution);
    if (!channel) continue;
    const cur = wonByChannel.get(channel) ?? { n: 0, value: 0 };
    cur.n++;
    cur.value += (d as any).value_cents ?? 0;
    wonByChannel.set(channel, cur);
  }

  const channels: ChannelStat[] = [...new Set([...spendByChannel.keys(), ...leadsByChannel.keys()])]
    .map((channel) => {
      const spendCents = spendByChannel.get(channel) ?? 0;
      const leads = leadsByChannel.get(channel) ?? 0;
      const w = wonByChannel.get(channel) ?? { n: 0, value: 0 };
      return {
        channel,
        spendCents,
        leads,
        cplCents: leads > 0 ? Math.round(spendCents / leads) : null,
        wonDeals: w.n,
        wonValueCents: w.value,
        costPerWonCents: w.n > 0 ? Math.round(spendCents / w.n) : null,
      };
    })
    .filter((c) => c.spendCents > 0 || c.leads > 0)
    .sort((a, b) => b.spendCents - a.spendCents);

  const totalSpend = [...spendByChannel.values()].reduce((a, b) => a + b, 0);
  return {
    days,
    channels,
    totals: {
      spendCents: totalSpend,
      newDeals: created.length,
      attributedDeals,
      blendedCacCents: created.length > 0 ? Math.round(totalSpend / created.length) : null,
      wonDeals: wonTotal,
      wonValueCents: wonValueTotal,
    },
    organicSources,
  };
}

// ── 10-minute cache so list-page enrichment doesn't recompute per request ──
let cache: { at: number; days: number; report: LeadCostReport } | null = null;

export async function cachedLeadCost(db: SupabaseClient, days = 30): Promise<LeadCostReport> {
  if (cache && cache.days === days && Date.now() - cache.at < 600_000) return cache.report;
  const report = await computeLeadCost(db, days);
  cache = { at: Date.now(), days, report };
  return report;
}
