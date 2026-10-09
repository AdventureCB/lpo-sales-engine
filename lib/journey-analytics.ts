import type { SupabaseClient } from "@supabase/supabase-js";
import { isOrganicSocialTouch } from "./campaign-roas";
import { pageLabel } from "./web-activity";

/**
 * Journey analytics: fold every recorded step for a deal (ad clicks, email
 * clicks, site sessions) into a channel path, then aggregate the paths into
 * repeating patterns, first-touch channels, landing pages and transitions.
 */

export type Channel = "Meta Ads" | "Google Ads" | "Email" | "Organic search" | "Social" | "Referral" | "Direct" | "Other paid";

export interface JourneyStep { at: string; channel: Channel; landing: string; landingLabel: string; campaign: string | null }
export interface Journey {
  dealId: string; created: string; wonAt: string | null; status: string; valueCents: number; sourceName: string | null;
  steps: JourneyStep[]; // collapsed: consecutive same-channel steps merged
  firstTouch: JourneyStep; lastBeforeDeal: JourneyStep | null; daysToDeal: number; touchesBeforeDeal: number;
}

function host(u: string | null): string | null {
  if (!u) return null;
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; }
}

export function classifyStep(s: any): Channel {
  const src = String(s.source ?? "").toLowerCase();
  const med = String(s.medium ?? "").toLowerCase();
  const ref = host(s.referrer);
  if (s.has_gclid || (src === "google" && /cpc|paid|ppc/.test(med))) return "Google Ads";
  if (isOrganicSocialTouch(s)) return "Social";
  if (s.has_fbclid || ["facebook", "fb", "meta", "instagram", "ig"].includes(src)) return "Meta Ads";
  if (src === "klaviyo" || med === "email" || /klaviyo|mail/.test(src)) return "Email";
  if (src === "bing" || src === "microsoft" || med === "cpc" || med === "paid") return "Other paid";
  if (ref) {
    if (/google\.|bing\.|duckduckgo|yahoo\.|ecosia/.test(ref)) return "Organic search";
    if (/facebook|instagram|l\.facebook|lm\.facebook|t\.co|twitter|x\.com|youtube|tiktok|reddit|linktr/.test(ref)) return "Social";
    if (/mail\.google|outlook|yahoo\.com\/mail|klaviyo/.test(ref)) return "Email";
    return "Referral";
  }
  if (src === "google") return "Organic search";
  if (src) return "Referral";
  return "Direct";
}

export async function loadJourneys(db: SupabaseClient, startIso: string, endIso: string): Promise<Journey[]> {
  const { data, error } = await db.rpc("journey_steps", { p_start: startIso, p_end: endIso });
  if (error) throw new Error(error.message);
  const byDeal = new Map<string, any[]>();
  for (const r of (data ?? []) as any[]) (byDeal.get(r.deal_id) ?? byDeal.set(r.deal_id, []).get(r.deal_id)!).push(r);

  const out: Journey[] = [];
  for (const rows of byDeal.values()) {
    rows.sort((a, b) => String(a.step_at).localeCompare(String(b.step_at)));
    const d = rows[0];
    // A site session that starts within 30 min after a touch IS that touch's landing — don't double count.
    const raw: JourneyStep[] = [];
    let lastTouchAt = -Infinity;
    for (const r of rows) {
      const at = Date.parse(r.step_at);
      if (r.kind === "visit" && at - lastTouchAt < 30 * 60_000) continue;
      if (r.kind === "touch") lastTouchAt = at;
      const landing = String(r.landing ?? "").split("?")[0] || "/";
      raw.push({ at: r.step_at, channel: classifyStep(r), landing, landingLabel: pageLabel(landing, null), campaign: r.campaign ?? null });
    }
    if (!raw.length) continue;
    // Collapse consecutive same-channel steps (a reload or 3 ads from one campaign = one step).
    const steps: JourneyStep[] = [];
    for (const s of raw) if (!steps.length || steps[steps.length - 1].channel !== s.channel) steps.push(s);
    const created = Date.parse(d.deal_created);
    const before = raw.filter((s) => Date.parse(s.at) <= created + 3_600_000);
    out.push({
      dealId: d.deal_id, created: d.deal_created, wonAt: d.won_at, status: d.status, valueCents: Number(d.value_cents ?? 0), sourceName: d.source_name,
      steps, firstTouch: raw[0], lastBeforeDeal: before[before.length - 1] ?? null,
      daysToDeal: Math.max(0, (created - Date.parse(raw[0].at)) / 86_400_000), touchesBeforeDeal: before.length,
    });
  }
  return out;
}

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

export function summarizeJourneys(js: Journey[]) {
  const won = js.filter((j) => j.status === "won");
  const byPattern = new Map<string, { pattern: string; leads: number; won: number; revenueCents: number; days: number[]; steps: number[] }>();
  const byFirst = new Map<string, { channel: string; leads: number; won: number; revenueCents: number; days: number[] }>();
  const byLanding = new Map<string, { label: string; path: string; leads: number; won: number; revenueCents: number; channels: Map<string, number> }>();
  const transitions = new Map<string, { from: string; to: string; n: number; won: number }>();
  const lengthHist = new Map<number, { steps: number; leads: number; won: number }>();
  for (const j of js) {
    const key = j.steps.map((s) => s.channel).join(" → ");
    const p = byPattern.get(key) ?? byPattern.set(key, { pattern: key, leads: 0, won: 0, revenueCents: 0, days: [], steps: [] }).get(key)!;
    p.leads++; p.days.push(j.daysToDeal); p.steps.push(j.touchesBeforeDeal);
    if (j.status === "won") { p.won++; p.revenueCents += j.valueCents; }

    const f = byFirst.get(j.firstTouch.channel) ?? byFirst.set(j.firstTouch.channel, { channel: j.firstTouch.channel, leads: 0, won: 0, revenueCents: 0, days: [] }).get(j.firstTouch.channel)!;
    f.leads++; f.days.push(j.daysToDeal); if (j.status === "won") { f.won++; f.revenueCents += j.valueCents; }

    const lk = j.firstTouch.landing;
    const l = byLanding.get(lk) ?? byLanding.set(lk, { label: j.firstTouch.landingLabel, path: lk, leads: 0, won: 0, revenueCents: 0, channels: new Map() }).get(lk)!;
    l.leads++; if (j.status === "won") { l.won++; l.revenueCents += j.valueCents; }
    l.channels.set(j.firstTouch.channel, (l.channels.get(j.firstTouch.channel) ?? 0) + 1);

    for (let i = 0; i + 1 < j.steps.length; i++) {
      const tk = `${j.steps[i].channel}|${j.steps[i + 1].channel}`;
      const t = transitions.get(tk) ?? transitions.set(tk, { from: j.steps[i].channel, to: j.steps[i + 1].channel, n: 0, won: 0 }).get(tk)!;
      t.n++; if (j.status === "won") t.won++;
    }
    const n = Math.min(j.steps.length, 6);
    const h = lengthHist.get(n) ?? lengthHist.set(n, { steps: n, leads: 0, won: 0 }).get(n)!;
    h.leads++; if (j.status === "won") h.won++;
  }
  const fin = <T extends { days: number[]; steps?: number[] }>(x: T) => {
    const { days, steps, ...rest } = x as T & { steps?: number[] };
    return { ...rest, medianDays: median(days), medianSteps: median(steps ?? []) };
  };
  return {
    totals: {
      deals: js.length, won: won.length, revenueCents: won.reduce((n, j) => n + j.valueCents, 0),
      paidFirst: js.filter((j) => j.firstTouch.channel === "Meta Ads" || j.firstTouch.channel === "Google Ads" || j.firstTouch.channel === "Other paid").length,
      medianDays: median(js.map((j) => j.daysToDeal)), medianTouches: median(js.map((j) => j.touchesBeforeDeal)),
      multiTouch: js.filter((j) => j.steps.length > 1).length,
    },
    patterns: [...byPattern.values()].map(fin).sort((a, b) => b.leads - a.leads).slice(0, 40),
    firstTouch: [...byFirst.values()].map(fin).sort((a, b) => b.leads - a.leads),
    landings: [...byLanding.values()].map((l) => ({ ...l, channels: [...l.channels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${c} ${n}`) })).sort((a, b) => b.leads - a.leads).slice(0, 25),
    transitions: [...transitions.values()].sort((a, b) => b.n - a.n).slice(0, 25),
    lengths: [...lengthHist.values()].sort((a, b) => a.steps - b.steps),
  };
}
