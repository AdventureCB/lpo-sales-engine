import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaudeTool, logAiUsage } from "./ai";
import { loadAiConfig } from "./ai-profiler";
import { normalizePhone } from "./identity";

/**
 * AI hypothesis engine — the self-improving outcome loop.
 *
 * The model proposes broad, falsifiable claims about pathways to outcomes
 * ("deals first-called within 24h win at 2× the rate") over EVERYTHING a
 * deal page knows: structured fields, calls, comms, engagement signals,
 * first-party attribution, profile state. Every claim compiles to a
 * predicate over the ai_deal_features snapshot, so testing is mechanical:
 *   proposed → backtest vs 2,400 historical closes (fails → rejected)
 *   → registered (timestamped) → scored ONLY on closes AFTER registration
 *   (pre-registration kills fit-the-noise survivors) → validated / retired.
 * Tokens are spent only on generation; testing is pure data. Humans approve
 * ACTIONABILITY (human_approved) — outcomes judge truth.
 */

// ── Feature catalog ─────────────────────────────────────────────────────────
export const FEATURES: Record<string, string> = {
  source: "deal source label (Quote Survey, Saved Build, Abandoned Cart, Hot List Import…)",
  pipeline: "pipeline name at close",
  value_band: '"0" | "1-5k" | "5-10k" | "10k+"',
  tz_region: "east | central | west | unknown",
  created_dow: "day of week created, 0=Sun…6=Sat",
  created_month: "month created, 1-12",
  truck_known: "boolean — truck model on file",
  interests_count: "number of interest chips",
  attr_first_source: "first-party attribution first-touch source (google, facebook, klaviyo…) or null",
  attr_last_source: "first-party attribution last-touch source or null",
  has_click_id: "boolean — gclid/fbclid… captured (paid-ad click)",
  attr_touches: "number of captured ad/site touches",
  eng_opens: "lifetime marketing email opens (engagement signals)",
  eng_clicks: "lifetime marketing email clicks",
  eng_types: "distinct engagement signal types",
  era: 'data era by close date: "pre_app" (closed before 2026-07, sparse call/comms capture) | "app" — condition on this to avoid era artifacts',
  dials: "total call attempts (call events + logged call activities)",
  conversations: "calls classified as real conversations (webhook-era calls only — sparse for pre_app)",
  talk_min: "total talk minutes",
  hours_to_first_call: "hours from deal creation to first outbound call (null = never called)",
  first_call_conversation: "boolean — the FIRST call was a real conversation",
  emails_out: "outbound rep emails",
  texts_out: "outbound rep texts",
  inbound_msgs: "inbound texts/emails from the buyer",
  hours_to_first_touch: "hours from creation to first outbound touch of ANY channel (null = never touched)",
  replied: "boolean — buyer ever replied after our first outbound",
  archetype: "dominant AI-profile archetype key, or null if unprofiled",
  profile_conf: "AI profile overall confidence 0-1, or null",
  // Coaching + comms-theme features (data starts 8/20 — near-zero pre_app
  // coverage; hypotheses on these prove themselves prospectively).
  reviewed_calls: "number of ⚖-reviewed calls on the deal",
  sb_guide: 'best verdict for StoryBrand "Guide positioning" across reviewed calls: hit|partial|missed|null',
  sb_problem: 'best verdict for "Problem articulation": hit|partial|missed|null',
  sb_plan: 'best verdict for "Simple plan": hit|partial|missed|null',
  sb_cta: 'best verdict for "Clear CTA": hit|partial|missed|null',
  sb_discovery: 'best verdict for "Discovery": hit|partial|missed|null',
  themes_used: "distinct AI draft themes actually used/sent on the deal",
  first_theme: "first theme used (quick_nudge|build_followup|financing|schedule|objection|recap|reengage|breakup) or null",
  second_theme: "second distinct theme used, or null — order claims compose first_theme + second_theme",
  theme_financing: "boolean — financing theme used at any point",
  theme_breakup: "boolean — breakup theme used at any point",
};
export const OPS = ["eq", "neq", "gte", "lte", "in", "notnull"] as const;
export const OUTCOMES = ["won", "fast_close", "replied_48h"] as const;

type Cond = { feature: string; op: (typeof OPS)[number]; value?: unknown };

// ── Snapshot builder (chunked; caller drives offsets under a time budget) ──
export async function buildFeatureChunk(
  db: SupabaseClient,
  offset: number,
  limit = 120
): Promise<{ processed: number; total: number }> {
  const { count: total } = await db
    .from("crm_deals")
    .select("id", { count: "exact", head: true })
    .in("status", ["won", "lost"]);
  const { data: deals } = await db
    .from("crm_deals")
    .select(
      "id, pipedrive_deal_id, contact_id, status, value_cents, pd_add_time, created_at, updated_at, truck_model, interests, deal_sources ( name ), crm_stages ( crm_pipelines ( name ) ), crm_contacts ( phones, tz_offset, attribution )"
    )
    .in("status", ["won", "lost"])
    .order("updated_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (!deals?.length) return { processed: 0, total: total ?? 0 };
  const rows = await computeRowsFor(db, deals);
  const { error } = await db.from("ai_deal_features").upsert(rows, { onConflict: "deal_id" });
  if (error) throw new Error(error.message);
  return { processed: rows.length, total: total ?? rows.length };
}

/** The deal-page feature vector for a batch of deal rows (any status). */
export const DEAL_FEATURE_SELECT =
  "id, pipedrive_deal_id, contact_id, status, value_cents, pd_add_time, created_at, updated_at, truck_model, interests, deal_sources ( name ), crm_stages ( crm_pipelines ( name ) ), crm_contacts ( phones, tz_offset, attribution )";

async function computeRowsFor(db: SupabaseClient, deals: any[]): Promise<any[]> {
  const ids = deals.map((d) => d.id);
  const pdIds = deals.map((d) => d.pipedrive_deal_id).filter((n) => n != null) as number[];
  const phoneToDeals = new Map<string, string[]>();
  for (const d of deals) {
    for (const p of ((d as any).crm_contacts?.phones as any[]) ?? []) {
      const e = normalizePhone(p?.e164 ?? p?.value);
      if (e) phoneToDeals.set(e, [...(phoneToDeals.get(e) ?? []), d.id]);
    }
  }
  const phones = [...phoneToDeals.keys()];

  const CALL_COLS_LITE = "quo_call_id, crm_deal_id, deal_id, direction, started_at, duration_s, classification";
  const [callsA, callsB, callsC, callsD, acts, inSms, engs, profs, reviews, drafts] = await Promise.all([
    db.from("call_events").select(CALL_COLS_LITE).in("crm_deal_id", ids),
    pdIds.length
      ? db.from("call_events").select(CALL_COLS_LITE).in("deal_id", pdIds)
      : Promise.resolve({ data: [] as any[] }),
    // Historical Quo calls are PERSON-linked, not deal-linked — match by the
    // contact's phone in the participants array (from = [0], to = [1]).
    phones.length
      ? db.from("call_events").select(`${CALL_COLS_LITE}, p0:raw->data->object->participants->>0`).in("raw->data->object->participants->>0", phones)
      : Promise.resolve({ data: [] as any[] }),
    phones.length
      ? db.from("call_events").select(`${CALL_COLS_LITE}, p1:raw->data->object->participants->>1`).in("raw->data->object->participants->>1", phones)
      : Promise.resolve({ data: [] as any[] }),
    db.from("crm_activities").select("deal_id, type, occurred_at, meta").in("deal_id", ids),
    phones.length
      ? db.from("sms_messages").select("peer_phone, sent_at").eq("direction", "incoming").in("peer_phone", phones)
      : Promise.resolve({ data: [] as any[] }),
    pdIds.length
      ? db.from("engagement_events").select("pipedrive_deal_id, type").in("pipedrive_deal_id", pdIds)
      : Promise.resolve({ data: [] as any[] }),
    db.from("deal_profiles").select("deal_id, archetypes, overall_confidence").in("deal_id", ids),
    db.from("call_reviews").select("deal_id, created_at, scorecard:review->scorecard").in("deal_id", ids),
    db.from("draft_events").select("deal_id, theme_key, generated_at, used_at, sent_activity_id").in("deal_id", ids).order("generated_at", { ascending: true }),
  ]);

  const pdToId = new Map(deals.map((d) => [d.pipedrive_deal_id, d.id]));
  const idSet = new Set(ids);
  const callsByDeal = new Map<string, any[]>();
  const seenCalls = new Set<string>();
  const addCall = (did: string | undefined | null, c: any) => {
    if (!did || !idSet.has(did)) return;
    const k = `${did}:${c.quo_call_id}`;
    if (seenCalls.has(k)) return;
    seenCalls.add(k);
    callsByDeal.set(did, [...(callsByDeal.get(did) ?? []), c]);
  };
  for (const c of [...(callsA.data ?? []), ...((callsB as any).data ?? [])]) {
    addCall((c.crm_deal_id as string) ?? pdToId.get(c.deal_id), c);
  }
  for (const c of [...((callsC as any).data ?? []), ...((callsD as any).data ?? [])]) {
    for (const ph of [(c as any).p0, (c as any).p1].filter(Boolean)) {
      for (const did of phoneToDeals.get(normalizePhone(ph) ?? ph) ?? []) addCall(did, c);
    }
  }
  const actsByDeal = new Map<string, any[]>();
  for (const a of acts.data ?? []) actsByDeal.set(a.deal_id, [...(actsByDeal.get(a.deal_id) ?? []), a]);
  const inboundByDeal = new Map<string, string[]>();
  for (const m of (inSms as any).data ?? []) {
    for (const did of phoneToDeals.get(m.peer_phone) ?? []) {
      inboundByDeal.set(did, [...(inboundByDeal.get(did) ?? []), m.sent_at]);
    }
  }
  const engByDeal = new Map<string, { opens: number; clicks: number; types: Set<string> }>();
  for (const e of (engs as any).data ?? []) {
    const did = pdToId.get(e.pipedrive_deal_id);
    if (!did) continue;
    const agg = engByDeal.get(did) ?? { opens: 0, clicks: 0, types: new Set<string>() };
    if (/open/.test(e.type)) agg.opens++;
    if (/click/.test(e.type)) agg.clicks++;
    agg.types.add(e.type);
    engByDeal.set(did, agg);
  }
  const profByDeal = new Map((profs.data ?? []).map((p) => [p.deal_id, p]));

  // ⚖ review scorecards: best verdict per StoryBrand principle per deal.
  const RANK: Record<string, number> = { missed: 1, partial: 2, hit: 3 };
  const sbByDeal = new Map<string, { n: number; best: Record<string, string> }>();
  for (const r of (reviews as any).data ?? []) {
    const agg = sbByDeal.get(r.deal_id) ?? { n: 0, best: {} };
    agg.n++;
    for (const item of (Array.isArray(r.scorecard) ? r.scorecard : []) as any[]) {
      const key = String(item.principle ?? "").toLowerCase();
      const v = String(item.verdict ?? "").toLowerCase();
      if (!RANK[v]) continue;
      const slot = key.includes("guide") ? "guide" : key.includes("problem") ? "problem" : key.includes("plan") ? "plan" : key.includes("cta") ? "cta" : key.includes("discovery") ? "discovery" : null;
      if (!slot) continue;
      if (!agg.best[slot] || RANK[v] > RANK[agg.best[slot]]) agg.best[slot] = v;
    }
    sbByDeal.set(r.deal_id, agg);
  }
  // Themes actually used (used-click or send linkage), in first-use order.
  const themesByDeal = new Map<string, string[]>();
  for (const ev of (drafts as any).data ?? []) {
    if (!ev.used_at && !ev.sent_activity_id) continue;
    const seq = themesByDeal.get(ev.deal_id) ?? [];
    if (ev.theme_key && !seq.includes(ev.theme_key)) seq.push(ev.theme_key);
    themesByDeal.set(ev.deal_id, seq);
  }

  const rows = deals.map((d: any) => {
    const created = Date.parse(d.pd_add_time ?? d.created_at);
    const closed = Date.parse(d.updated_at);
    const calls = (callsByDeal.get(d.id) ?? []).sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
    const outCalls = calls.filter((c) => c.direction === "outgoing");
    const convo = (c: any) => c.classification === "conversation" || (c.duration_s ?? 0) >= 120;
    const dealActs = actsByDeal.get(d.id) ?? [];
    // Pre-webhook history: calls exist only as PD-mirrored call ACTIVITIES.
    // Count them toward dials/first-call timing, deduped against call events
    // logged within 5 minutes.
    const eventTimes = calls.map((c) => Date.parse(c.started_at)).filter(Number.isFinite);
    const callActs = dealActs.filter(
      (a) =>
        a.type === "call" &&
        a.occurred_at &&
        !eventTimes.some((t) => Math.abs(t - Date.parse(a.occurred_at)) < 5 * 60_000)
    );
    const allCallTimes = [...outCalls.map((c) => Date.parse(c.started_at)), ...callActs.map((a: any) => Date.parse(a.occurred_at))]
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const firstCallTs = allCallTimes[0] ?? null;
    const firstCall = outCalls[0] ?? null;
    const emailsOut = dealActs.filter((a) => a.type === "email" && (a.meta?.direction ?? "outbound") !== "inbound");
    const emailsIn = dealActs.filter((a) => a.type === "email" && a.meta?.direction === "inbound");
    const textsOut = dealActs.filter((a) => a.type === "sms");
    const inboundSms = inboundByDeal.get(d.id) ?? [];
    const firstOutTs = Math.min(
      ...[emailsOut[0]?.occurred_at, textsOut[0]?.occurred_at].filter(Boolean).map((t: any) => Date.parse(t)),
      firstCallTs ?? Infinity,
      Infinity
    );
    const inboundTimes = [...inboundSms.map((t) => Date.parse(t)), ...emailsIn.map((a: any) => Date.parse(a.occurred_at))].filter(
      (t) => Number.isFinite(t) && Number.isFinite(firstOutTs) && t > firstOutTs
    );
    const firstReply = inboundTimes.length ? Math.min(...inboundTimes) : null;
    const eng = engByDeal.get(d.id);
    const prof: any = profByDeal.get(d.id);
    const archetypes: any[] = Array.isArray(prof?.archetypes) ? prof.archetypes : [];
    const dominant = archetypes.slice().sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0] ?? null;
    const v = d.value_cents ?? 0;
    const tz = d.crm_contacts?.tz_offset;
    const attr = d.crm_contacts?.attribution ?? {};
    const touches: any[] = Array.isArray(attr.touches) ? attr.touches : [];
    const clickId = Boolean(
      attr.last?.gclid || attr.last?.fbclid || attr.last?.gbraid || attr.first?.gclid || attr.first?.fbclid
    );
    const features = {
      source: d.deal_sources?.name ?? null,
      pipeline: d.crm_stages?.crm_pipelines?.name ?? null,
      value_band: v <= 0 ? "0" : v < 500_000 ? "1-5k" : v < 1_000_000 ? "5-10k" : "10k+",
      tz_region: tz === -5 || tz === -4 ? "east" : tz === -6 ? "central" : tz != null ? "west" : "unknown",
      created_dow: new Date(created).getUTCDay(),
      created_month: new Date(created).getUTCMonth() + 1,
      truck_known: Boolean(d.truck_model),
      interests_count: (d.interests ?? []).length,
      attr_first_source: attr.first?.utm_source ?? attr.first?.source ?? (attr.first?.gclid ? "google" : attr.first?.fbclid ? "facebook" : null),
      attr_last_source: attr.last?.utm_source ?? attr.last?.source ?? (attr.last?.gclid ? "google" : attr.last?.fbclid ? "facebook" : null),
      has_click_id: clickId,
      attr_touches: touches.length,
      eng_opens: eng?.opens ?? 0,
      eng_clicks: eng?.clicks ?? 0,
      eng_types: eng?.types.size ?? 0,
      era: closed < Date.parse("2026-07-01") ? "pre_app" : "app",
      dials: outCalls.length + callActs.length,
      conversations: calls.filter(convo).length,
      talk_min: Math.round(calls.reduce((s, c) => s + (c.duration_s ?? 0), 0) / 60),
      hours_to_first_call: firstCallTs != null ? Math.max(0, Math.round((firstCallTs - created) / 3600_000)) : null,
      first_call_conversation: firstCall ? convo(firstCall) : false,
      emails_out: emailsOut.length,
      texts_out: textsOut.length,
      inbound_msgs: inboundSms.length + emailsIn.length,
      hours_to_first_touch: Number.isFinite(firstOutTs) ? Math.max(0, Math.round((firstOutTs - created) / 3600_000)) : null,
      replied: firstReply != null,
      archetype: dominant?.key ?? null,
      profile_conf: prof?.overall_confidence ?? null,
      reviewed_calls: sbByDeal.get(d.id)?.n ?? 0,
      sb_guide: sbByDeal.get(d.id)?.best.guide ?? null,
      sb_problem: sbByDeal.get(d.id)?.best.problem ?? null,
      sb_plan: sbByDeal.get(d.id)?.best.plan ?? null,
      sb_cta: sbByDeal.get(d.id)?.best.cta ?? null,
      sb_discovery: sbByDeal.get(d.id)?.best.discovery ?? null,
      themes_used: (themesByDeal.get(d.id) ?? []).length,
      first_theme: themesByDeal.get(d.id)?.[0] ?? null,
      second_theme: themesByDeal.get(d.id)?.[1] ?? null,
      theme_financing: (themesByDeal.get(d.id) ?? []).includes("financing"),
      theme_breakup: (themesByDeal.get(d.id) ?? []).includes("breakup"),
    };
    const outcomes = {
      won: d.status === "won",
      fast_close: d.status === "won" && closed - created <= 30 * 86_400_000,
      replied_48h: firstReply != null && Number.isFinite(firstOutTs) && firstReply - firstOutTs <= 48 * 3600_000,
    };
    return { deal_id: d.id, status: d.status, closed_at: d.updated_at, features, outcomes, computed_at: new Date().toISOString() };
  });

  return rows;
}

// ── Predicate evaluation ────────────────────────────────────────────────────
export function evalCohort(features: Record<string, unknown>, cohort: Cond[]): boolean {
  return cohort.every((c) => {
    const v = features[c.feature];
    switch (c.op) {
      case "notnull": return v != null;
      case "eq": return v === c.value || (typeof v === "boolean" && v === (c.value === true || c.value === "true"));
      case "neq": return v !== c.value;
      case "gte": return typeof v === "number" && v >= Number(c.value);
      case "lte": return typeof v === "number" && v <= Number(c.value);
      case "in": return Array.isArray(c.value) && (c.value as unknown[]).includes(v);
      default: return false;
    }
  });
}

function twoPropZ(h1: number, n1: number, h2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 0;
  const p1 = h1 / n1, p2 = h2 / n2, p = (h1 + h2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (p1 - p2) / se;
}

export function testHypothesis(
  rows: { features: any; outcomes: any }[],
  cohort: Cond[],
  outcome: string
): { cohort_n: number; cohort_hits: number; base_n: number; base_hits: number; lift: number; z: number } {
  // replied_48h only makes sense for deals we actually reached out to.
  const universe = outcome === "replied_48h" ? rows.filter((r) => r.features.hours_to_first_touch != null) : rows;
  let cn = 0, ch = 0, bn = 0, bh = 0;
  for (const r of universe) {
    const hit = Boolean(r.outcomes[outcome]);
    if (evalCohort(r.features, cohort)) { cn++; if (hit) ch++; }
    else { bn++; if (hit) bh++; }
  }
  const cr = cn ? ch / cn : 0, br = bn ? bh / bn : 0;
  return { cohort_n: cn, cohort_hits: ch, base_n: bn, base_hits: bh, lift: br > 0 ? cr / br : cr > 0 ? 99 : 1, z: twoPropZ(ch, cn, bh, bn) };
}

// ── Generation ──────────────────────────────────────────────────────────────
const TOOL = {
  name: "propose_hypotheses",
  description: "Propose falsifiable pathway-to-outcome hypotheses over the deal feature catalog.",
  input_schema: {
    type: "object",
    properties: {
      hypotheses: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            claim: { type: "string", description: "One-sentence falsifiable claim, plain English" },
            rationale: { type: "string", description: "Why this pattern is plausible (mechanism, not restatement)" },
            category: { type: "string", enum: ["timing", "channel", "sequence", "attribution", "engagement", "profile", "deal", "other"] },
            cohort: {
              type: "array", minItems: 1, maxItems: 4,
              items: {
                type: "object",
                properties: {
                  feature: { type: "string" },
                  op: { type: "string", enum: [...OPS] },
                  value: { description: "comparison value; array for op=in; omit for notnull" },
                },
                required: ["feature", "op"],
              },
            },
            outcome: { type: "string", enum: [...OUTCOMES] },
            direction: { type: "string", enum: ["higher", "lower"] },
          },
          required: ["claim", "rationale", "category", "cohort", "outcome", "direction"],
        },
      },
    },
    required: ["hypotheses"],
  },
};

function rollup(rows: any[], feature: string, outcome: string, bucketer?: (v: any) => string): string {
  const groups = new Map<string, { n: number; h: number }>();
  for (const r of rows) {
    const raw = r.features[feature];
    const key = bucketer ? bucketer(raw) : String(raw ?? "null");
    const g = groups.get(key) ?? { n: 0, h: 0 };
    g.n++;
    if (r.outcomes[outcome]) g.h++;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.n >= 15)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 12)
    .map(([k, g]) => `${k}: ${((g.h / g.n) * 100).toFixed(1)}% (n=${g.n})`)
    .join(" | ");
}

export async function runHypothesisGeneration(db: SupabaseClient): Promise<{ proposed: number; registered: number; rejected: number }> {
  const cfg = await loadAiConfig(db);
  const { data: rows } = await pageAll(db);
  if (!rows.length) throw new Error("no feature snapshot — build features first");

  const base = rows.filter((r) => r.outcomes.won).length / rows.length;
  const numBucket = (edges: number[]) => (v: any) =>
    v == null ? "null" : String(edges.find((e) => v <= e) ?? `>${edges[edges.length - 1]}`);
  const digest = [
    `Universe: ${rows.length} closed deals; base win rate ${(base * 100).toFixed(1)}%.`,
    `Win rate by source: ${rollup(rows, "source", "won")}`,
    `Win rate by value_band: ${rollup(rows, "value_band", "won")}`,
    `Win rate by tz_region: ${rollup(rows, "tz_region", "won")}`,
    `Win rate by archetype: ${rollup(rows, "archetype", "won")}`,
    `Win rate by attr_first_source: ${rollup(rows, "attr_first_source", "won")}`,
    `Win rate by has_click_id: ${rollup(rows, "has_click_id", "won")}`,
    `Win rate by hours_to_first_call (≤ bucket): ${rollup(rows, "hours_to_first_call", "won", numBucket([1, 4, 24, 72, 168]))}`,
    `Win rate by hours_to_first_touch: ${rollup(rows, "hours_to_first_touch", "won", numBucket([1, 4, 24, 72, 168]))}`,
    `Win rate by conversations: ${rollup(rows, "conversations", "won", numBucket([0, 1, 2, 4]))}`,
    `Win rate by texts_out: ${rollup(rows, "texts_out", "won", numBucket([0, 1, 3, 6]))}`,
    `Win rate by emails_out: ${rollup(rows, "emails_out", "won", numBucket([0, 1, 3, 6]))}`,
    `Win rate by eng_opens: ${rollup(rows, "eng_opens", "won", numBucket([0, 2, 5, 15]))}`,
    `Win rate by replied: ${rollup(rows, "replied", "won")}`,
    `Win rate by first_call_conversation: ${rollup(rows, "first_call_conversation", "won")}`,
    `Win rate by created_dow: ${rollup(rows, "created_dow", "won")}`,
    `replied_48h rate by hours_to_first_touch: ${rollup(rows.filter((r) => r.features.hours_to_first_touch != null), "hours_to_first_touch", "replied_48h", numBucket([1, 4, 24, 72]))}`,
    `fast_close rate by source: ${rollup(rows, "source", "fast_close")}`,
    `Win rate by sb_plan (StoryBrand Simple-plan verdict, reviewed calls only): ${rollup(rows.filter((r) => r.features.sb_plan != null), "sb_plan", "won") || "no data yet"}`,
    `Win rate by first_theme (draft themes, data starts 8/20): ${rollup(rows.filter((r) => r.features.first_theme != null), "first_theme", "won") || "no data yet"}`,
  ].join("\n");

  const catalog = Object.entries(FEATURES).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  const call = await callClaudeTool({
    tier: cfg.models.critic ?? "sonnet",
    systemCached:
      `You generate falsifiable hypotheses about pathways to outcomes for Lone Peak Overland's sales pipeline (made-to-order truck-bed campers, long consultative sales cycle, outbound-heavy reps).\n\n` +
      `FEATURE CATALOG (cohorts may ONLY use these, with ops eq/neq/gte/lte/in/notnull):\n${catalog}\n\n` +
      `Outcomes: won (deal won), fast_close (won within 30 days), replied_48h (buyer replied within 48h of first outreach).\n\n` +
      `Rules:\n- Each hypothesis must be a testable cohort-vs-everyone-else rate comparison.\n` +
      `- Prefer ACTIONABLE patterns (timing, channel mix, sequence, engagement thresholds) a rep or automation could act on — not demographic truisms.\n` +
      `- NO tautologies: never define a cohort with features that mechanically imply the outcome (e.g. replied predicting replied_48h, conversations≥1 predicting won-because-talked).\n` +
      `- Mine SURPRISING patterns the aggregates hint at, and reasonable mechanisms the aggregates don't directly show (they'll be tested).\n` +
      `- Cohorts need plausible size — avoid conditions so narrow that n<20 of ~2400.`,
    user: `AGGREGATES OVER THE CLOSED-DEAL UNIVERSE:\n${digest}\n\nPropose up to 12 hypotheses.`,
    tool: TOOL,
    maxTokens: 4000,
  });
  await logAiUsage(db, { dealId: null, task: "hypotheses", tier: cfg.models.critic ?? "sonnet", call });

  const proposals: any[] = (call.input as any).hypotheses ?? [];
  let registered = 0, rejected = 0, proposed = 0;
  for (const h of proposals) {
    const cohort: Cond[] = (h.cohort ?? []).filter((c: any) => FEATURES[c.feature] && OPS.includes(c.op));
    if (!cohort.length || cohort.length !== (h.cohort ?? []).length) continue;
    if (!OUTCOMES.includes(h.outcome)) continue;
    proposed++;
    const bt = testHypothesis(rows, cohort, h.outcome);
    const pass =
      bt.cohort_n >= 20 &&
      bt.base_n >= 50 &&
      (h.direction === "lower" ? bt.z <= -2 : bt.z >= 2);
    await db.from("ai_hypotheses").insert({
      claim: String(h.claim).slice(0, 500),
      rationale: String(h.rationale ?? "").slice(0, 1000),
      category: h.category ?? "other",
      cohort,
      outcome: h.outcome,
      direction: h.direction === "lower" ? "lower" : "higher",
      status: pass ? "registered" : "rejected",
      backtest: { ...bt, at: new Date().toISOString() },
      registered_at: pass ? new Date().toISOString() : null,
      scored_through: pass ? new Date().toISOString() : null,
      model: call.model,
    });
    if (pass) registered++;
    else rejected++;
  }
  return { proposed, registered, rejected };
}

async function pageAll(db: SupabaseClient): Promise<{ data: any[] }> {
  const all: any[] = [];
  for (let page = 0; page < 20; page++) {
    const { data } = await db
      .from("ai_deal_features")
      .select("deal_id, closed_at, features, outcomes")
      .order("closed_at", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    all.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return { data: all };
}

// ── Prospective scoring (zero tokens) ───────────────────────────────────────
export async function scoreProspective(db: SupabaseClient): Promise<{ scored: number; updated: number }> {
  const { data: hyps } = await db
    .from("ai_hypotheses")
    .select("*")
    .in("status", ["registered", "validated"]);
  if (!hyps?.length) return { scored: 0, updated: 0 };

  const { data: rows } = await pageAll(db);
  let updated = 0;
  for (const h of hyps) {
    const fresh = rows.filter((r) => r.closed_at > (h.scored_through ?? h.registered_at));
    if (!fresh.length) continue;
    const t = testHypothesis(fresh, h.cohort as Cond[], h.outcome);
    const p = h.prospective as any;
    const next = {
      cohort_n: p.cohort_n + t.cohort_n,
      cohort_hits: p.cohort_hits + t.cohort_hits,
      base_n: p.base_n + t.base_n,
      base_hits: p.base_hits + t.base_hits,
    };
    const z = twoPropZ(next.cohort_hits, next.cohort_n, next.base_hits, next.base_n);
    const dirZ = h.direction === "lower" ? -z : z;
    let status = h.status;
    let retire: Record<string, unknown> = {};
    if (next.cohort_n >= 20 && dirZ >= 1.65) status = "validated";
    if (next.cohort_n >= 15 && dirZ <= -1.0) {
      status = "retired";
      retire = { retired_at: new Date().toISOString(), retire_reason: `prospective z ${z.toFixed(2)} contradicts direction` };
    }
    await db
      .from("ai_hypotheses")
      .update({
        prospective: next,
        prospective_z: z,
        status,
        scored_through: fresh[fresh.length - 1].closed_at,
        ...retire,
      })
      .eq("id", h.id);
    updated++;
  }
  return { scored: rows.length, updated };
}

// ── Per-deal close likelihood (admin-only surface; hot-list-v2 seed) ────────
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Indicative close-likelihood for one deal: start from the base win rate,
 * shift log-odds for every active WON-outcome hypothesis whose cohort the
 * deal is in (weight grows with prospectively-earned certainty; each factor
 * and the total are clamped because overlapping hypotheses double-count).
 * Transparent by construction — returns the contributing factors.
 */
export async function dealCloseScore(
  db: SupabaseClient,
  dealId: string
): Promise<{ probability: number; base: number; factors: { claim: string; direction: string; shift: number; status: string }[] } | null> {
  const { data: deal } = await db.from("crm_deals").select(DEAL_FEATURE_SELECT).eq("id", dealId).maybeSingle();
  if (!deal) return null;
  const [row] = await computeRowsFor(db, [deal]);
  if (!row) return null;

  const [{ data: hyps }, { count: uniN }, { count: uniWon }] = await Promise.all([
    db.from("ai_hypotheses").select("*").in("status", ["registered", "validated"]).eq("outcome", "won"),
    db.from("ai_deal_features").select("deal_id", { count: "exact", head: true }),
    db.from("ai_deal_features").select("deal_id", { count: "exact", head: true }).eq("status", "won"),
  ]);
  const base = (uniWon ?? 480) / Math.max(1, uniN ?? 2100);
  let lo = logit(base);
  const factors: { claim: string; direction: string; shift: number; status: string }[] = [];
  for (const h of hyps ?? []) {
    if (!evalCohort(row.features, h.cohort as Cond[])) continue;
    const b = h.backtest as any;
    if (!b?.cohort_n) continue;
    // add-1 smoothed rates from the backtest; certainty-weighted (0.35 floor
    // while prospective evidence is thin).
    const cr = (b.cohort_hits + 1) / (b.cohort_n + 2);
    const br = (b.base_hits + 1) / (b.base_n + 2);
    const p = h.prospective as any;
    const dirZ = h.direction === "lower" ? -(h.prospective_z ?? 0) : h.prospective_z ?? 0;
    const earned = p?.cohort_n >= 10 ? Math.min(1, Math.max(0, 0.5 + dirZ / 4)) : 0.35;
    const shift = Math.max(-1.2, Math.min(1.2, (logit(cr) - logit(br)) * earned));
    lo += shift;
    factors.push({ claim: h.claim, direction: h.direction, shift: Math.round(shift * 100) / 100, status: h.status });
  }
  lo = Math.max(logit(base) - 2.5, Math.min(logit(base) + 2.5, lo));
  factors.sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift));
  return { probability: Math.round(sigmoid(lo) * 100) / 100, base: Math.round(base * 100) / 100, factors };
}

// ── Steering (Kyle's practical-psychology layer; master toggle default OFF) ─
/**
 * The validated+approved patterns this deal matches, for prompt injection —
 * plus theme boosts derived from theme-feature cohorts. Empty unless
 * cfg.steering_enabled AND a hypothesis passes BOTH gates (statistically
 * validated + human_approved). Retired hypotheses drop out automatically.
 */
export async function steeringForDeal(
  db: SupabaseClient,
  dealId: string,
  cap = 3
): Promise<{ patterns: string[]; themeBoosts: Record<string, number> }> {
  const empty = { patterns: [], themeBoosts: {} as Record<string, number> };
  const cfg = await loadAiConfig(db);
  if (!cfg.steering_enabled) return empty;
  const { data: hyps } = await db
    .from("ai_hypotheses")
    .select("claim, cohort, outcome, direction, prospective, prospective_z")
    .eq("status", "validated")
    .eq("human_approved", true);
  if (!hyps?.length) return empty;

  const { data: deal } = await db.from("crm_deals").select(DEAL_FEATURE_SELECT).eq("id", dealId).maybeSingle();
  if (!deal) return empty;
  const [row] = await computeRowsFor(db, [deal]);
  if (!row) return empty;

  const matched = hyps
    .filter((h) => evalCohort(row.features, h.cohort as Cond[]))
    .map((h) => {
      const dirZ = h.direction === "lower" ? -(h.prospective_z ?? 0) : h.prospective_z ?? 0;
      const cert = Math.round((1 / (1 + Math.exp(-1.702 * (dirZ / 2)))) * 100);
      return { ...h, cert };
    })
    .sort((a, b) => b.cert - a.cert);

  const themeBoosts: Record<string, number> = {};
  for (const h of matched) {
    if (h.direction !== "higher") continue;
    for (const c of h.cohort as Cond[]) {
      if ((c.feature === "first_theme" || c.feature === "second_theme") && c.op === "eq" && typeof c.value === "string") {
        themeBoosts[c.value] = Math.max(themeBoosts[c.value] ?? 0, h.cert);
      }
      if (c.feature === "theme_financing" && c.op === "eq") themeBoosts.financing = Math.max(themeBoosts.financing ?? 0, h.cert);
      if (c.feature === "theme_breakup" && c.op === "eq") themeBoosts.breakup = Math.max(themeBoosts.breakup ?? 0, h.cert);
    }
  }
  return {
    patterns: matched.slice(0, cap).map((h) => `${h.claim} (${h.cert}% certain on post-registration closes; outcome: ${h.outcome})`),
    themeBoosts,
  };
}

/**
 * Stamp hypothesis-driven close likelihood onto ACTIVE hot flags (nightly,
 * steering-gated). hot_flags.deal_id is the internal deal number — real PD
 * id or synthetic — so the crm_deals join always resolves.
 */
export async function stampHotFlagScores(db: SupabaseClient): Promise<{ stamped: number }> {
  const cfg = await loadAiConfig(db);
  if (!cfg.steering_enabled) return { stamped: 0 };
  const { data: flags } = await db.from("hot_flags").select("id, deal_id").is("cleared_at", null).limit(150);
  if (!flags?.length) return { stamped: 0 };
  const { data: deals } = await db
    .from("crm_deals")
    .select(DEAL_FEATURE_SELECT)
    .in("pipedrive_deal_id", flags.map((f) => f.deal_id));
  if (!deals?.length) return { stamped: 0 };
  const rows = await computeRowsFor(db, deals);
  const featByPd = new Map(deals.map((d: any, i) => [d.pipedrive_deal_id, rows.find((r) => r.deal_id === d.id)]));

  const [{ data: hyps }, { count: uniN }, { count: uniWon }] = await Promise.all([
    db.from("ai_hypotheses").select("*").in("status", ["registered", "validated"]).eq("outcome", "won"),
    db.from("ai_deal_features").select("deal_id", { count: "exact", head: true }),
    db.from("ai_deal_features").select("deal_id", { count: "exact", head: true }).eq("status", "won"),
  ]);
  const base = (uniWon ?? 480) / Math.max(1, uniN ?? 2100);
  let stamped = 0;
  for (const f of flags) {
    const row = featByPd.get(f.deal_id);
    if (!row) continue;
    let lo = logit(base);
    for (const h of hyps ?? []) {
      if (!evalCohort(row.features, h.cohort as Cond[])) continue;
      const b = h.backtest as any;
      if (!b?.cohort_n) continue;
      const cr = (b.cohort_hits + 1) / (b.cohort_n + 2);
      const br = (b.base_hits + 1) / (b.base_n + 2);
      const p = h.prospective as any;
      const dirZ = h.direction === "lower" ? -(h.prospective_z ?? 0) : h.prospective_z ?? 0;
      const earned = p?.cohort_n >= 10 ? Math.min(1, Math.max(0, 0.5 + dirZ / 4)) : 0.35;
      lo += Math.max(-1.2, Math.min(1.2, (logit(cr) - logit(br)) * earned));
    }
    lo = Math.max(logit(base) - 2.5, Math.min(logit(base) + 2.5, lo));
    await db.from("hot_flags").update({ close_score: Math.round(sigmoid(lo) * 100) / 100 }).eq("id", f.id);
    stamped++;
  }
  return { stamped };
}
