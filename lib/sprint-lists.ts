import type { SupabaseClient } from "@supabase/supabase-js";
import { isAllDayIso } from "./allday";

/**
 * Sprint Lists — daily auto-generated call lists on the sprint rail.
 *
 * Lists 1 & 2 (morning, one-click): a rep's OWN open deals, TZ-partitioned and
 * ranked down a 6-rung ladder. List 3 (auto 1pm): same-day undialed carryover
 * from lists 1&2 + the rep's 60-90d stale deals + the shared Cainen
 * reprospecting pool (exclusive 3-day checkout).
 *
 * Everything reads the CRM mirror only — zero Pipedrive calls.
 */

// ── Config ─────────────────────────────────────────────────────────────────

export type SprintListConfig = {
  cap: number;
  reprospect_subcap: number | null;
  checkout_hold_days: number;
  windows: {
    hot_days: number;
    new_deal_days: number;
    marketing_signal_days: number;
    recent_activity_days: number;
    scheduled_ahead_days: number;
    no_conversation_days: number;
    stale_min_days: number;
    stale_max_days: number;
    cap_fill_no_activity_days: number;
  };
  hot_1a_regex: string; // high-intent buy signals (tier 1a)
  hot_1b_regex: string; // ACTIVE engagement (tier 1b) — excludes passive opens
  clock: { list1: string; list2: string; list3: string };
  cainen_owner_pipedrive_id: number | null;
};

export const DEFAULT_CONFIG: SprintListConfig = {
  cap: 60,
  reprospect_subcap: null,
  checkout_hold_days: 3,
  windows: {
    hot_days: 7,
    new_deal_days: 14,
    marketing_signal_days: 14,
    recent_activity_days: 7,
    scheduled_ahead_days: 7,
    no_conversation_days: 60,
    stale_min_days: 60,
    stale_max_days: 90,
    cap_fill_no_activity_days: 60,
  },
  // Matched against engagement_events.type (snake_case): Shopify buy-intent.
  hot_1a_regex: "(cart|checkout|builder_save|save.?build|3d.?build|abandon)",
  // Active engagement only — deliberately excludes email_open (too noisy: ~all
  // contacts open marketing mail). Clicks/views/forms/subscribes count.
  hot_1b_regex: "(click|viewed_product|active_on_site|form|subscrib|builder|3d|order)",
  clock: { list1: "09:00", list2: "12:00", list3: "13:00" },
  cainen_owner_pipedrive_id: null, // null = pool is UNASSIGNED deals (owner is null)
};

// ── Confirmation Pipeline exclusion ─────────────────────────────────────────
// Deals in the Confirmation Pipeline are post-sale confirmation work — they
// must never appear on call lists. Stage uuids cached 10 min per process.
let confStageCache: { ids: string[]; at: number } | null = null;

async function confirmationStageIds(db: SupabaseClient): Promise<string[]> {
  if (confStageCache && Date.now() - confStageCache.at < 600_000) return confStageCache.ids;
  const { data: pipes } = await db.from("crm_pipelines").select("id").ilike("name", "%confirmation%");
  const pids = (pipes ?? []).map((p) => p.id);
  let ids: string[] = [];
  if (pids.length) {
    const { data: stages } = await db.from("crm_stages").select("id").in("pipeline_id", pids);
    ids = (stages ?? []).map((s) => s.id);
  }
  confStageCache = { ids, at: Date.now() };
  return ids;
}

/** Chainable filter: drop deals sitting in a Confirmation Pipeline stage. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function notConfirmation<T = any>(q: T, ids: string[]): T {
  return ids.length ? (q as any).not("stage_id", "in", `(${ids.join(",")})`) : q;
}

export async function loadConfig(db: SupabaseClient): Promise<SprintListConfig> {
  const { data } = await db.from("sprint_list_config").select("config").eq("id", true).maybeSingle();
  const c = (data?.config ?? {}) as Partial<SprintListConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...c,
    windows: { ...DEFAULT_CONFIG.windows, ...(c.windows ?? {}) },
    clock: { ...DEFAULT_CONFIG.clock, ...(c.clock ?? {}) },
  };
}

// ── Timezone bucketing ─────────────────────────────────────────────────────
// East = {-4,-5}, Central = {-6}, West = {-7,-8,-9,-10}.

export type TzBucket = "east" | "central" | "west";

export function tzBucket(off: number | null): TzBucket | null {
  if (off == null) return null;
  if (off >= -5) return "east";
  if (off === -6) return "central";
  return "west";
}

// Slot 1 = East+Central; Slot 2 = West. `sub` orders the front block (tiers
// 1-2): East before Central (slot 1); Mountain before Pacific+ (slot 2).
const SLOT_TZ: Record<number, { offsets: number[]; sub: (off: number) => number }> = {
  1: { offsets: [-4, -5, -6], sub: (off) => (off >= -5 ? 0 : 1) },
  2: { offsets: [-7, -8, -9, -10], sub: (off) => (off === -7 ? 0 : 1) },
};

// ── Ranked item shape ──────────────────────────────────────────────────────

export type ListItem = {
  crmDealId: string;
  pipedriveDealId: number | null;
  title: string;
  personName: string | null;
  phone: string | null;
  tzBucket: TzBucket | null;
  tier: number; // 1..6
  tierLabel: string; // '1a','1b','2'..'6'
  source: "ladder" | "carryover" | "stale" | "reprospect";
  recencyAt: string | null; // ISO, for within-tier ordering (desc)
  flag?: string | null; // rep-facing note (e.g. buy-signal override)
};

const TIER_RANK: Record<string, number> = { "1a": 0, "1b": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6 };

// ── Small helpers ──────────────────────────────────────────────────────────

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** LA-local YYYY-MM-DD for an instant (handles PST/PDT). */
function laDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function primaryPhone(phones: any[]): string | null {
  // A number struck as `bad` (bad_number disposition) is never dialable — a
  // deal with only bad numbers falls off lists; a good secondary keeps it on.
  const ok = (phones ?? []).filter((p) => !p.bad);
  return (
    ok.find((p) => p.primary && p.e164)?.e164 ??
    ok.find((p) => p.e164)?.e164 ??
    null
  );
}

/** Paginated fetch that respects the 1000-row PostgREST cap. */
async function fetchAll(build: (from: number, to: number) => any): Promise<any[]> {
  const out: any[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ── Per-deal fact enrichment (shared by all slots) ─────────────────────────

type DealRow = {
  id: string;
  pipedrive_deal_id: number | null;
  title: string;
  created_at: string;
  pd_add_time: string | null;
  last_activity_at: string | null;
  contact_id: string | null;
  crm_contacts: {
    id: string;
    name: string | null;
    emails: any[];
    phones: any[];
    tz_offset: number | null;
  } | null;
};

type Facts = {
  hot1aAt: string | null;
  hot1bAt: string | null;
  nextPendingDueAt: string | null; // earliest pending (undone) activity due
  scheduledNext7: boolean;
  marketingAt: string | null; // most recent marketing signal <= window
  hasAnyCall: boolean;
  lastConversationAt: string | null;
};

/**
 * Enrich a set of deals with the signal/activity facts the ladder needs.
 * Loads three tiny tables once and matches in memory — no per-deal queries.
 */
async function enrich(
  db: SupabaseClient,
  deals: DealRow[],
  cfg: SprintListConfig,
  todayLa: string
): Promise<Map<string, Facts>> {
  const w = cfg.windows;
  const hot1a = new RegExp(cfg.hot_1a_regex, "i");
  const hot1b = new RegExp(cfg.hot_1b_regex, "i");

  // Index deals by email and by phone for signal/call matching.
  const emailToDeals = new Map<string, string[]>();
  const phoneToDeals = new Map<string, string[]>();
  const pdIdToDeal = new Map<number, string>();
  for (const d of deals) {
    if (d.pipedrive_deal_id != null) pdIdToDeal.set(d.pipedrive_deal_id, d.id);
    for (const e of d.crm_contacts?.emails ?? []) {
      const k = (e.value ?? "").toLowerCase();
      if (k) (emailToDeals.get(k) ?? emailToDeals.set(k, []).get(k)!).push(d.id);
    }
    for (const p of d.crm_contacts?.phones ?? []) {
      const k = p.e164;
      if (k) (phoneToDeals.get(k) ?? phoneToDeals.set(k, []).get(k)!).push(d.id);
    }
  }

  const marketingDays = Math.max(w.marketing_signal_days, w.hot_days);
  const callDays = Math.max(w.no_conversation_days, w.new_deal_days, 1);
  const in7dIso = new Date(Date.now() + w.scheduled_ahead_days * 86_400_000).toISOString();
  const nowIso = new Date().toISOString();

  const [engagement, calls, pending] = await Promise.all([
    // Marketing signals come from engagement_events (the hot-list cron sweeps
    // this broadly — 12k+ contacts), NOT klaviyo_events (only ~16 contacts,
    // synced lazily on page-view). Buy-intent (checkout/builder_save) is
    // Shopify-sourced here; email opens/clicks are Klaviyo-sourced.
    fetchAll((f, t) =>
      db
        .from("engagement_events")
        .select("person_email, pipedrive_deal_id, type, occurred_at")
        .gte("occurred_at", daysAgoIso(marketingDays))
        .order("occurred_at", { ascending: false })
        .range(f, t)
    ),
    fetchAll((f, t) =>
      db
        .from("call_events")
        .select("deal_id, classification, disposition, started_at, raw")
        .eq("direction", "outgoing")
        .gte("started_at", daysAgoIso(callDays))
        .range(f, t)
    ),
    // All pending (undone) scheduled activities from ~90d ago into the future
    // — future-dated ones suppress a deal until their date; due/overdue = tier 2.
    fetchAll((f, t) =>
      db
        .from("crm_activities")
        .select("deal_id, contact_id, due_at, actor")
        .is("done_at", null)
        .not("due_at", "is", null)
        .gte("due_at", daysAgoIso(90))
        .range(f, t)
    ),
  ]);

  const facts = new Map<string, Facts>();
  const get = (id: string): Facts =>
    facts.get(id) ??
    facts
      .set(id, {
        hot1aAt: null,
        hot1bAt: null,
        nextPendingDueAt: null,
        scheduledNext7: false,
        marketingAt: null,
        hasAnyCall: false,
        lastConversationAt: null,
      })
      .get(id)!;

  const hotCutoff = daysAgoIso(w.hot_days);
  const mktgCutoff = daysAgoIso(w.marketing_signal_days);
  for (const ev of engagement) {
    const at = ev.occurred_at;
    // engagement_events attribute by direct deal id (5k rows carry it) OR email.
    const ids = new Set<string>();
    if (ev.pipedrive_deal_id != null && pdIdToDeal.has(ev.pipedrive_deal_id)) ids.add(pdIdToDeal.get(ev.pipedrive_deal_id)!);
    for (const id of emailToDeals.get((ev.person_email ?? "").toLowerCase()) ?? []) ids.add(id);
    if (!ids.size) continue;
    const is1a = hot1a.test(ev.type ?? "");
    const is1b = hot1b.test(ev.type ?? ""); // active engagement only, not opens
    for (const id of ids) {
      const fct = get(id);
      // Marketing signal (tier 4) counts ANY event, incl. passive opens.
      if (at >= mktgCutoff && (!fct.marketingAt || at > fct.marketingAt)) fct.marketingAt = at;
      if (at >= hotCutoff) {
        if (is1a && (!fct.hot1aAt || at > fct.hot1aAt)) fct.hot1aAt = at;
        if (is1b && (!fct.hot1bAt || at > fct.hot1bAt)) fct.hot1bAt = at;
      }
    }
  }

  for (const ce of calls) {
    // Match by linked Pipedrive deal id, else by any participant phone.
    let ids: string[] | undefined;
    if (ce.deal_id != null && pdIdToDeal.has(ce.deal_id)) ids = [pdIdToDeal.get(ce.deal_id)!];
    else {
      const parts: string[] = ce.raw?.data?.object?.participants ?? [];
      const seen = new Set<string>();
      for (const p of parts) for (const id of phoneToDeals.get(p) ?? []) seen.add(id);
      if (seen.size) ids = [...seen];
    }
    if (!ids) continue;
    const isConversation = ce.classification === "conversation" || ce.disposition === "connected";
    for (const id of ids) {
      const fct = get(id);
      fct.hasAnyCall = true;
      if (isConversation && ce.started_at && (!fct.lastConversationAt || ce.started_at > fct.lastConversationAt)) {
        fct.lastConversationAt = ce.started_at;
      }
    }
  }

  for (const a of pending) {
    // Sprint lists run off APP-created activities ONLY (Kyle, 8/20). Rows
    // without an actor originated in Pipedrive — legacy imports and the
    // hot-list cron's PD-side "call today" tasks — and must neither suppress
    // a deal nor promote it to tier 2 ("scheduled"). App writes always stamp
    // an actor (rep email / 'intake' / 'automation').
    if (!a.actor || a.actor === "sys") continue;
    const targets = [a.deal_id, /* contact fallthrough below */].filter(Boolean) as string[];
    let ids: string[] = a.deal_id ? [a.deal_id] : [];
    // contact-linked pending activities apply to that contact's deals
    if (!a.deal_id && a.contact_id) ids = deals.filter((d) => d.contact_id === a.contact_id).map((d) => d.id);
    void targets;
    for (const id of ids) {
      const fct = get(id);
      if (!fct.nextPendingDueAt || a.due_at < fct.nextPendingDueAt) fct.nextPendingDueAt = a.due_at;
      if (a.due_at > nowIso && a.due_at <= in7dIso) fct.scheduledNext7 = true;
    }
  }

  return facts;
}

/** Assign a deal its highest-qualifying ladder tier (or null = not on list). */
function classify(
  d: DealRow,
  f: Facts,
  cfg: SprintListConfig,
  todayLa: string
): { tier: number; tierLabel: string; recencyAt: string | null; flag?: string | null } | null {
  const w = cfg.windows;
  const created = d.pd_add_time ?? d.created_at;
  const la = d.last_activity_at;
  const recentActivity = la != null && la >= daysAgoIso(w.recent_activity_days);

  // Future-dated scheduled activity: hide the deal until that date (then it
  // resurfaces as tier 2) — you already have a plan for it. EXCEPTION: a fresh
  // high-intent buy signal with nothing scheduled in the next 7 days still
  // surfaces (flagged), so the rep can act on renewed intent.
  // All-day activities (00:00 UTC by convention, lib/allday) belong on their
  // UTC date — running them through laDate shifted them a day EARLY, so
  // tomorrow's planned calls leaked onto today's list.
  const due = f.nextPendingDueAt;
  const dueLa = due ? (isAllDayIso(due) ? due.slice(0, 10) : laDate(new Date(due))) : null;
  if (dueLa && dueLa > todayLa) {
    if (f.hot1aAt && !f.scheduledNext7) {
      return { tier: 1, tierLabel: "1a", recencyAt: f.hot1aAt, flag: `🔥 New buy signal — callback scheduled ${dueLa}` };
    }
    return null;
  }

  if (f.hot1aAt) return { tier: 1, tierLabel: "1a", recencyAt: f.hot1aAt };
  if (f.hot1bAt) return { tier: 1, tierLabel: "1b", recencyAt: f.hot1bAt };
  // A scheduled activity due today (or overdue) surfaces at tier 2 — flagged
  // honestly when it's an OVERDUE task rather than one planned for today.
  if (dueLa) {
    const flag = dueLa < todayLa ? `⏰ Task overdue since ${dueLa.slice(5).replace("-", "/")}` : null;
    return { tier: 2, tierLabel: "2", recencyAt: f.nextPendingDueAt, flag };
  }
  if (created >= daysAgoIso(w.new_deal_days) && !f.hasAnyCall)
    return { tier: 3, tierLabel: "3", recencyAt: created };
  if (f.marketingAt && !recentActivity && !f.scheduledNext7)
    return { tier: 4, tierLabel: "4", recencyAt: f.marketingAt };
  const noConv = f.lastConversationAt == null || f.lastConversationAt < daysAgoIso(w.no_conversation_days);
  if (noConv) return { tier: 5, tierLabel: "5", recencyAt: la };
  const noActivity = la == null || la < daysAgoIso(w.cap_fill_no_activity_days);
  if (noActivity) return { tier: 6, tierLabel: "6", recencyAt: la };
  return null;
}

// ── Slot 1 & 2: the ladder ─────────────────────────────────────────────────

async function computeLadder(
  db: SupabaseClient,
  repPipedriveId: number,
  slot: 1 | 2,
  cfg: SprintListConfig
): Promise<ListItem[]> {
  const { offsets, sub } = SLOT_TZ[slot];
  const todayLa = laDate(new Date());
  const confIds = await confirmationStageIds(db);

  const deals = (await fetchAll((f, t) =>
    notConfirmation(
      db
        .from("crm_deals")
        .select(
          "id, pipedrive_deal_id, title, created_at, pd_add_time, last_activity_at, contact_id, crm_contacts!inner ( id, name, emails, phones, tz_offset )"
        )
        .eq("status", "open")
        .eq("owner_pipedrive_id", repPipedriveId)
        .filter("crm_contacts.tz_offset", "in", `(${offsets.join(",")})`),
      confIds
    ).range(f, t)
  )) as DealRow[];

  const facts = await enrich(db, deals, cfg, todayLa);

  const items: (ListItem & { _sub: number; _contactId: string | null })[] = [];
  for (const d of deals) {
    const off = d.crm_contacts?.tz_offset;
    if (off == null) continue;
    const phone = primaryPhone(d.crm_contacts?.phones ?? []);
    if (!phone) continue;
    const cls = classify(d, facts.get(d.id) ?? blankFacts(), cfg, todayLa);
    if (!cls) continue;
    items.push({
      crmDealId: d.id,
      pipedriveDealId: d.pipedrive_deal_id,
      title: d.title,
      personName: d.crm_contacts?.name ?? null,
      phone,
      tzBucket: tzBucket(off),
      tier: cls.tier,
      tierLabel: cls.tierLabel,
      source: "ladder",
      recencyAt: cls.recencyAt,
      flag: cls.flag ?? null,
      _sub: sub(off),
      _contactId: d.contact_id,
    });
  }

  // Front block (tiers 1-2) ordered by sub-bucket then tier; mixed block
  // (tiers 3-6) ordered by tier only. Within a cell: recency desc.
  items.sort((a, b) => {
    const aFront = TIER_RANK[a.tierLabel] <= 2 ? 0 : 1;
    const bFront = TIER_RANK[b.tierLabel] <= 2 ? 0 : 1;
    if (aFront !== bFront) return aFront - bFront;
    if (aFront === 0 && a._sub !== b._sub) return a._sub - b._sub;
    if (TIER_RANK[a.tierLabel] !== TIER_RANK[b.tierLabel]) return TIER_RANK[a.tierLabel] - TIER_RANK[b.tierLabel];
    return (b.recencyAt ?? "").localeCompare(a.recencyAt ?? "");
  });

  // One entry per contact — you dial the person once. Sort is best-first, so
  // the first occurrence is their top-ranked deal.
  const seenContact = new Set<string>();
  const deduped = items.filter((it) => {
    if (!it._contactId) return true;
    if (seenContact.has(it._contactId)) return false;
    seenContact.add(it._contactId);
    return true;
  });

  const capped = cfg.cap ? deduped.slice(0, cfg.cap) : deduped;
  return capped.map(({ _sub, _contactId, ...it }) => it);
}

function blankFacts(): Facts {
  return {
    hot1aAt: null,
    hot1bAt: null,
    nextPendingDueAt: null,
    scheduledNext7: false,
    marketingAt: null,
    hasAnyCall: false,
    lastConversationAt: null,
  };
}

// ── Public: compute one slot's ranked items (does not persist) ─────────────

export async function computeList(
  db: SupabaseClient,
  args: { repEmail: string; repPipedriveId: number; slot: 1 | 2 | 3; forDate: string },
  cfg: SprintListConfig
): Promise<ListItem[]> {
  if (args.slot === 1 || args.slot === 2) return computeLadder(db, args.repPipedriveId, args.slot, cfg);
  return computeList3(db, args, cfg);
}

// ── Slot 3: carryover + stale + reprospecting pool ─────────────────────────

async function computeList3(
  db: SupabaseClient,
  args: { repEmail: string; repPipedriveId: number; forDate: string },
  cfg: SprintListConfig
): Promise<ListItem[]> {
  const w = cfg.windows;
  const seen = new Set<string>();
  const out: ListItem[] = [];

  // 1) Carryover: today's undialed items from this rep's lists 1 & 2.
  const { data: dailies } = await db
    .from("crm_sprints")
    .select("id, slot, crm_sprint_items ( deal_id, called_at, removed_at, tier, tier_label, tz_bucket )")
    .eq("owner", args.repEmail)
    .eq("kind", "daily")
    .eq("for_date", args.forDate)
    .in("slot", [1, 2]);
  const carryDealIds: { deal_id: string; tier: number; tier_label: string; tz_bucket: string }[] = [];
  for (const s of dailies ?? []) {
    for (const it of (s as any).crm_sprint_items ?? []) {
      if (it.called_at || it.removed_at) continue;
      carryDealIds.push({ deal_id: it.deal_id, tier: it.tier, tier_label: it.tier_label, tz_bucket: it.tz_bucket });
    }
  }
  if (carryDealIds.length) {
    const byId = await loadDealsById(
      db,
      carryDealIds.map((c) => c.deal_id)
    );
    const carry: ListItem[] = [];
    for (const c of carryDealIds) {
      const d = byId.get(c.deal_id);
      if (!d) continue;
      const phone = primaryPhone(d.crm_contacts?.phones ?? []);
      if (!phone || seen.has(d.id)) continue;
      seen.add(d.id);
      carry.push({
        crmDealId: d.id,
        pipedriveDealId: d.pipedrive_deal_id,
        title: d.title,
        personName: d.crm_contacts?.name ?? null,
        phone,
        tzBucket: (c.tz_bucket as TzBucket) ?? tzBucket(d.crm_contacts?.tz_offset ?? null),
        tier: c.tier ?? 6,
        tierLabel: c.tier_label ?? "carry",
        source: "carryover",
        recencyAt: d.last_activity_at,
      });
    }
    // Preserve the ladder order the deals had on lists 1 & 2.
    carry.sort((a, b) => {
      const ar = TIER_RANK[a.tierLabel] ?? 9;
      const br = TIER_RANK[b.tierLabel] ?? 9;
      if (ar !== br) return ar - br;
      return (b.recencyAt ?? "").localeCompare(a.recencyAt ?? "");
    });
    out.push(...carry);
  }

  // 2) Stale: rep's open deals whose last CUSTOMER engagement (answered call
  // OR inbound email reply) was 60-90d ago. Per Kyle's refinement — rep
  // outbound emails keep last_activity_at fresh, so they don't count here.
  const confIds3 = await confirmationStageIds(db);
  const repDeals = (await fetchAll((f, t) =>
    notConfirmation(
      db
        .from("crm_deals")
        .select("id, pipedrive_deal_id, title, contact_id, crm_contacts ( name, phones, tz_offset )")
        .eq("status", "open")
        .eq("owner_pipedrive_id", args.repPipedriveId),
      confIds3
    ).range(f, t)
  )) as any[];
  const engAt = await customerEngagementRecency(db, repDeals, w.stale_max_days);
  const staleMaxT = daysAgoIso(w.stale_max_days);
  const staleMinT = daysAgoIso(w.stale_min_days);
  const staleDeals = repDeals
    .filter((d) => {
      const at = engAt.get(d.id);
      return at != null && at >= staleMaxT && at < staleMinT;
    })
    .sort((a, b) => (engAt.get(b.id) ?? "").localeCompare(engAt.get(a.id) ?? ""));
  for (const d of staleDeals) {
    if (seen.has(d.id)) continue;
    const phone = primaryPhone(d.crm_contacts?.phones ?? []);
    if (!phone) continue;
    seen.add(d.id);
    out.push({
      crmDealId: d.id,
      pipedriveDealId: d.pipedrive_deal_id,
      title: d.title,
      personName: d.crm_contacts?.name ?? null,
      phone,
      tzBucket: tzBucket(d.crm_contacts?.tz_offset ?? null),
      tier: 7,
      tierLabel: "stale",
      source: "stale",
      recencyAt: engAt.get(d.id) ?? null,
    });
  }

  // 3) Reprospecting pool — handled by claimReprospect (needs to write locks),
  // so computeList3 returns carryover+stale; the generate step appends pool.
  return out;
}

async function loadDealsById(db: SupabaseClient, ids: string[]): Promise<Map<string, DealRow>> {
  const map = new Map<string, DealRow>();
  const confIds = await confirmationStageIds(db);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    // Open, non-Confirmation deals only — a deal marked Lost/Confirmed or
    // moved into the Confirmation Pipeline since the morning list must never
    // carry into List 3.
    const { data } = await notConfirmation(
      db
        .from("crm_deals")
        .select("id, pipedrive_deal_id, title, created_at, pd_add_time, last_activity_at, contact_id, status, crm_contacts ( id, name, emails, phones, tz_offset )")
        .in("id", chunk)
        .eq("status", "open"),
      confIds
    );
    for (const d of (data ?? []) as any[]) map.set(d.id, d);
  }
  return map;
}

/**
 * Per-deal most-recent CUSTOMER engagement within `days`: the later of an
 * answered outbound call (conversation) and an inbound email reply. Used for
 * the list-3 stale window — rep-outbound touches deliberately don't count.
 */
async function customerEngagementRecency(
  db: SupabaseClient,
  deals: { id: string; pipedrive_deal_id: number | null; contact_id: string | null; crm_contacts: any }[],
  days: number
): Promise<Map<string, string>> {
  const phoneToDeals = new Map<string, string[]>();
  const pdIdToDeal = new Map<number, string>();
  const contactToDeals = new Map<string, string[]>();
  for (const d of deals) {
    if (d.pipedrive_deal_id != null) pdIdToDeal.set(d.pipedrive_deal_id, d.id);
    if (d.contact_id) (contactToDeals.get(d.contact_id) ?? contactToDeals.set(d.contact_id, []).get(d.contact_id)!).push(d.id);
    for (const p of d.crm_contacts?.phones ?? []) {
      if (p.e164) (phoneToDeals.get(p.e164) ?? phoneToDeals.set(p.e164, []).get(p.e164)!).push(d.id);
    }
  }

  const since = daysAgoIso(days);
  const [calls, inbound] = await Promise.all([
    fetchAll((f, t) =>
      db
        .from("call_events")
        .select("deal_id, classification, disposition, started_at, raw")
        .eq("direction", "outgoing")
        .gte("started_at", since)
        .range(f, t)
    ),
    fetchAll((f, t) =>
      db
        .from("crm_activities")
        .select("contact_id, deal_id, occurred_at")
        .eq("type", "email")
        .filter("meta->>direction", "eq", "inbound")
        .gte("occurred_at", since)
        .range(f, t)
    ),
  ]);

  const out = new Map<string, string>();
  const bump = (id: string, at: string | null) => {
    if (!at) return;
    if (!out.has(id) || at > out.get(id)!) out.set(id, at);
  };

  for (const ce of calls) {
    if (!(ce.classification === "conversation" || ce.disposition === "connected")) continue;
    let ids: string[] = [];
    if (ce.deal_id != null && pdIdToDeal.has(ce.deal_id)) ids = [pdIdToDeal.get(ce.deal_id)!];
    else {
      const parts: string[] = ce.raw?.data?.object?.participants ?? [];
      const seen = new Set<string>();
      for (const p of parts) for (const id of phoneToDeals.get(p) ?? []) seen.add(id);
      ids = [...seen];
    }
    for (const id of ids) bump(id, ce.started_at);
  }
  for (const a of inbound) {
    const ids = a.deal_id ? [a.deal_id] : a.contact_id ? contactToDeals.get(a.contact_id) ?? [] : [];
    for (const id of ids) bump(id, a.occurred_at);
  }
  return out;
}

// ── Reprospecting pool: exclusive 3-day checkout ───────────────────────────
// Re-includes this rep's still-active holds (the 3-day push) and claims new
// Cainen-pool deals to fill remaining cap, ordered by most-recent marketing
// signal. The partial-unique index guarantees one rep per deal.

async function claimReprospect(
  db: SupabaseClient,
  args: { repEmail: string; repPipedriveId: number; forDate: string },
  cfg: SprintListConfig,
  remaining: number
): Promise<ListItem[]> {
  // Pool = UNASSIGNED open deals (owner null). cainen_owner_pipedrive_id is a
  // legacy tunable: when set, the pool is that owner's deals instead (the
  // pre-8/19 model where Cainen fronted the pool because PD required an owner).
  const poolOwnerId = cfg.cainen_owner_pipedrive_id;

  // Active checkouts across all reps (locked set) + this rep's own (re-include).
  const { data: active } = await db
    .from("crm_reprospect_checkouts")
    .select("deal_id, rep_email, expires_at")
    .is("released_at", null)
    .gt("expires_at", new Date().toISOString());
  const lockedByOther = new Set<string>();
  const mine = new Set<string>();
  for (const c of active ?? []) {
    if (c.rep_email === args.repEmail) mine.add(c.deal_id);
    else lockedByOther.add(c.deal_id);
  }

  // Load the whole open pool (paginated) with contacts + emails.
  const confIdsPool = await confirmationStageIds(db);
  const pool = (await fetchAll((f, t) => {
    let q = db
      .from("crm_deals")
      .select("id, pipedrive_deal_id, title, last_activity_at, contact_id, crm_contacts ( name, emails, phones, tz_offset )")
      .eq("status", "open");
    q = poolOwnerId ? q.eq("owner_pipedrive_id", poolOwnerId) : q.is("owner_pipedrive_id", null);
    return notConfirmation(q, confIdsPool).range(f, t);
  })) as any[];

  // Marketing recency per email (any age — "last marketing signal" wins).
  const mkt = await latestSignalByEmail(db);
  const signalAt = (d: any): string | null => {
    let best: string | null = null;
    for (const e of d.crm_contacts?.emails ?? []) {
      const at = mkt.get((e.value ?? "").toLowerCase());
      if (at && (!best || at > best)) best = at;
    }
    return best;
  };

  const toItem = (d: any): ListItem => ({
    crmDealId: d.id,
    pipedriveDealId: d.pipedrive_deal_id,
    title: d.title,
    personName: d.crm_contacts?.name ?? null,
    phone: primaryPhone(d.crm_contacts?.phones ?? []),
    tzBucket: tzBucket(d.crm_contacts?.tz_offset ?? null),
    tier: 8,
    tierLabel: "reprospect",
    source: "reprospect",
    recencyAt: signalAt(d),
  });

  const byId = new Map(pool.map((d) => [d.id, d]));
  const items: ListItem[] = [];

  // 1) Re-include this rep's active holds (prior commitments, ignore cap).
  for (const id of mine) {
    const d = byId.get(id);
    if (d && primaryPhone(d.crm_contacts?.phones ?? [])) items.push(toItem(d));
  }

  // 2) Claim new deals to fill remaining slots, ranked by marketing recency.
  const subcap = cfg.reprospect_subcap ?? Infinity;
  let newSlots = Math.min(Math.max(remaining, 0), subcap) - items.length;
  if (newSlots > 0) {
    const candidates = pool
      .filter((d) => !mine.has(d.id) && !lockedByOther.has(d.id) && primaryPhone(d.crm_contacts?.phones ?? []))
      .sort((a, b) => (signalAt(b) ?? "").localeCompare(signalAt(a) ?? ""));
    const expires = new Date(Date.now() + cfg.checkout_hold_days * 86_400_000).toISOString();
    for (const d of candidates) {
      if (newSlots <= 0) break;
      // Claim atomically: the partial-unique index rejects a double-claim.
      const { error } = await db
        .from("crm_reprospect_checkouts")
        .insert({ deal_id: d.id, rep_email: args.repEmail, expires_at: expires });
      if (error) continue; // already claimed by a racing rep — skip
      items.push(toItem(d));
      newSlots--;
    }
  }

  return items.filter((it) => it.phone);
}

async function latestSignalByEmail(db: SupabaseClient): Promise<Map<string, string>> {
  // Reprospect pool ordering: most-recent marketing signal wins. Reads the
  // broad engagement_events store (not the near-empty klaviyo_events).
  const rows = await fetchAll((f, t) =>
    db
      .from("engagement_events")
      .select("person_email, occurred_at")
      .order("occurred_at", { ascending: false })
      .range(f, t)
  );
  const m = new Map<string, string>();
  for (const r of rows) {
    const k = (r.person_email ?? "").toLowerCase();
    if (k && !m.has(k)) m.set(k, r.occurred_at); // first = latest (ordered desc)
  }
  return m;
}

// ── Persist a generated list onto the sprint rail ──────────────────────────

const SLOT_META: Record<number, { label: string }> = {
  1: { label: "East + Central" },
  2: { label: "West" },
  3: { label: "Follow-up + Reprospect" },
};

/** True once both daily Lists 1 & 2 exist for a rep on a date. */
export async function dailyListsExist(
  db: SupabaseClient,
  repEmail: string,
  forDate: string,
  slots: number[]
): Promise<boolean> {
  const { data } = await db
    .from("crm_sprints")
    .select("slot")
    .eq("owner", repEmail)
    .eq("kind", "daily")
    .eq("for_date", forDate)
    .in("slot", slots);
  const present = new Set((data ?? []).map((r: any) => r.slot));
  return slots.every((s) => present.has(s));
}

export class ListPrereqError extends Error {}

export async function generateAndSave(
  db: SupabaseClient,
  args: { repEmail: string; repPipedriveId: number; slot: 1 | 2 | 3; forDate: string },
  cfg: SprintListConfig
): Promise<{ sprintId: string; count: number; items: ListItem[] }> {
  // List 3 depends on Lists 1 & 2 (it carries their undialed leads forward),
  // so it can only be built once both exist for the day.
  if (args.slot === 3 && !(await dailyListsExist(db, args.repEmail, args.forDate, [1, 2]))) {
    throw new ListPrereqError("Generate Lists 1 & 2 first");
  }

  let items = await computeList(db, args, cfg);

  // List 3 appends the reprospecting pool after carryover + stale.
  if (args.slot === 3) {
    const remaining = cfg.cap ? cfg.cap - items.length : Infinity;
    const pool = await claimReprospect(db, args, cfg, remaining);
    items = [...items, ...pool];
  }
  if (cfg.cap && args.slot === 3) items = capList3(items, cfg.cap);

  const name = `List ${args.slot} — ${SLOT_META[args.slot].label} (${args.forDate})`;

  // Find or create the daily sprint (unique on owner+slot+for_date).
  const { data: existing } = await db
    .from("crm_sprints")
    .select("id")
    .eq("owner", args.repEmail)
    .eq("kind", "daily")
    .eq("slot", args.slot)
    .eq("for_date", args.forDate)
    .maybeSingle();

  let sprintId = existing?.id as string | undefined;
  // Preserve dial progress / manual edits across regeneration.
  const prev = new Map<string, { called_at: string | null; removed_at: string | null; added_manually: boolean }>();
  if (sprintId) {
    const { data: old } = await db
      .from("crm_sprint_items")
      .select("deal_id, called_at, removed_at, added_manually")
      .eq("sprint_id", sprintId);
    for (const o of old ?? []) prev.set(o.deal_id, o as any);
    await db.from("crm_sprints").update({ name, cap: cfg.cap, generated_at: new Date().toISOString(), status: "active" }).eq("id", sprintId);
    await db.from("crm_sprint_items").delete().eq("sprint_id", sprintId).eq("added_manually", false);
  } else {
    const { data: created, error } = await db
      .from("crm_sprints")
      .insert({ name, owner: args.repEmail, kind: "daily", slot: args.slot, for_date: args.forDate, cap: cfg.cap, generated_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error || !created) throw error ?? new Error("sprint insert failed");
    sprintId = created.id;
  }

  const rows = items.map((it, i) => {
    const p = prev.get(it.crmDealId);
    return {
      sprint_id: sprintId,
      deal_id: it.crmDealId,
      position: i,
      called_at: p?.called_at ?? null,
      removed_at: p?.removed_at ?? null,
      tier: it.tier,
      tier_label: it.tierLabel,
      source: it.source,
      tz_bucket: it.tzBucket,
      flag: it.flag ?? null,
      added_manually: p?.added_manually ?? false,
    };
  });
  // Skip deals already present as manual adds (kept above) to avoid PK clash.
  const keep = rows.filter((r) => !(prev.get(r.deal_id)?.added_manually));
  if (keep.length) {
    const { error } = await db.from("crm_sprint_items").upsert(keep, { onConflict: "sprint_id,deal_id" });
    if (error) throw error;
  }

  return { sprintId: sprintId!, count: items.length, items };
}

/** Cap list 3 without dropping active reprospect holds (prior commitments). */
function capList3(items: ListItem[], cap: number): ListItem[] {
  if (items.length <= cap) return items;
  const held = items.filter((i) => i.source === "reprospect");
  const rest = items.filter((i) => i.source !== "reprospect");
  const kept = rest.slice(0, Math.max(cap - held.length, 0));
  // Preserve original ordering: carryover/stale first, then held reprospect.
  return [...kept, ...held];
}
