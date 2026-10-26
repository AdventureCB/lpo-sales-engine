import type { SupabaseClient } from "@supabase/supabase-js";
import { fillPlaceholders } from "./placeholders";
import { sendTrackedEmail } from "./email-send";
import { sendTrackedSms } from "./sms-send";
import { normalizePhone } from "./identity";
import { bestSendTime } from "./campaign-timing";
import { draftSimilarity } from "./ai-scripts";

/**
 * Drip campaign engine (Phase 0/1 — macro campaigns; AI generation lands in
 * Phase 2 behind the same queue).
 *
 * Lifecycle per enrollment:
 *   enroll → (wait delay) → DRAFT the next step's send into the Outbox
 *   → owner/admin approves (edit/skip/stop) → SEND at scheduled_for from the
 *   deal owner's Gmail → next step … → completed.
 * Every cron pass also re-checks EXIT rules (reply, other rep contacted,
 * deal closed, opt-out) and HOLD rules (owner's own manual send <24h ago,
 * weekly cap, Klaviyo activity, contact-local send window).
 */

export const WEEKLY_CAP = 2; // campaign sends per contact per channel per 7 days
export const OWNER_SEND_HOLD_H = 24; // owner emailed/texted by hand → wait this long
export const DRAFT_AHEAD_H = 24; // drafts appear in the Outbox this far ahead of their slot
export const DEFAULT_WINDOW = { start: 9, end: 17 }; // contact-local hours (email)
export const SMS_WINDOW = { start: 9, end: 18 }; // texts: quiet hours are mandatory
const OPT_OUT_RE = /\b(unsubscribe|opt[ -]?out|remove me|stop (emailing|texting|contacting|messaging)|don'?t (email|text|contact|message) me|take me off)\b/i;

export interface CampaignTrigger {
  type: "manual" | "state";
  source?: string | null; // deal_sources.name
  min_attempts?: number | null;
  max_contacts?: number | null; // e.g. 0 = never had a conversation
  min_contacts?: number | null; // e.g. 1 = has had at least one conversation
  has_phone?: "yes" | "no" | null; // usable phone on the contact (null = either) — e.g. email-only leads
  min_days_since_created?: number | null;
  min_days_since_activity?: number | null;
  pipeline?: string | null; // crm_pipelines.name
  // Website behavior (source="site" engagement_events from attr.js v2):
  // enroll only deals whose contact showed this signal recently.
  web_signal?: import("./web-signal-labels").WebSignalKind | null;
  web_within_days?: number | null; // default 7
  web_min_count?: number | null; // default 1 (e.g. 2 = returned at least twice)
  // Ownership (Kyle 10/26): "assigned" = owned by a rep OR checked out to one
  // (reprospect hold); "unassigned" = in the pool with no active checkout.
  assignment?: "any" | "assigned" | "unassigned" | null;
  // Campaign fatigue gate (Kyle 10/26): skip people who received ANY campaign
  // message on this channel (from any campaign) within the last N days.
  no_campaign_days?: number | null;
  no_campaign_channel?: "sms" | "email" | null; // default sms
  // Same idea for a rep's OWN messages: skip anyone a rep texted/emailed by
  // hand within N days (campaign sends excluded).
  no_manual_days?: number | null;
  no_manual_channel?: "sms" | "email" | "any" | null; // default any
}

export { WEB_SIGNAL_LABELS } from "./web-signal-labels";
export interface CampaignSettings {
  window_start?: number; // contact-local hour
  window_end?: number;
  exit_on_reply?: boolean; // default true
  stop_on_other_rep?: boolean; // default true
  reenroll_after_days?: number; // legacy default for reentry_days
  // Re-entry gate (Kyle 10/26): a deal may ENTER this campaign at most
  // reentry_max times within any reentry_days window (default 1 in 60).
  reentry_max?: number;
  reentry_days?: number;
}
export interface Campaign {
  id: string; name: string; channel: "email" | "sms"; mode: "macro" | "ai"; status: string;
  owner_email: string | null; shared: boolean; trigger: CampaignTrigger; settings: CampaignSettings;
}
export interface CampaignStep {
  id: string; campaign_id: string; position: number; delay_hours: number;
  content_kind: "inline" | "macro" | "prompt"; macro_id: string | null; subject: string | null; body: string | null;
  prompt: string | null; steering: string | null; conditions: { skip_if_opened_prev?: boolean; only_if_opened_prev?: boolean };
}

const hours = (h: number) => h * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Deal owner's app email (owner_email, else via the rep's Pipedrive id). */
export async function dealOwnerEmail(db: SupabaseClient, deal: { owner_email?: string | null; owner_pipedrive_id?: number | null }): Promise<string | null> {
  if (deal.owner_email) return deal.owner_email;
  if (deal.owner_pipedrive_id == null) return null;
  const { data } = await db.from("reps").select("email").eq("pipedrive_user_id", deal.owner_pipedrive_id).maybeSingle();
  return data?.email ?? null;
}

/** First usable address for the channel on a contact. */
function contactAddress(contact: any, channel: "email" | "sms"): string | null {
  if (!contact) return null;
  if (channel === "email") {
    const emails = (contact.emails as any[]) ?? [];
    const e = emails.find((x) => x.primary && x.value) ?? emails.find((x) => x.value);
    return e?.value ? String(e.value).trim().toLowerCase() : null;
  }
  const phones = ((contact.phones as any[]) ?? []).filter((p) => !p.bad);
  const p = phones.find((x) => x.primary && (x.e164 || x.value)) ?? phones.find((x) => x.e164 || x.value);
  return p ? normalizePhone(p.e164 ?? p.value) : null;
}

// ── Enrollment ──────────────────────────────────────────────────────────────

export interface EnrollResult { dealId: string; ok: boolean; reason?: string }

/** Enroll deals into a campaign, applying every eligibility rule. */
export async function enrollDeals(db: SupabaseClient, campaign: Campaign, dealIds: string[], by: string): Promise<EnrollResult[]> {
  if (!dealIds.length) return [];
  const { data: steps } = await db.from("campaign_steps").select("id, delay_hours").eq("campaign_id", campaign.id).order("position").limit(1);
  const firstDelay = steps?.[0]?.delay_hours ?? 0;
  const { data: deals } = await db
    .from("crm_deals")
    .select("id, status, owner_email, owner_pipedrive_id, contact_id, crm_contacts ( id, emails, phones, dnc, sms_consent, email_unsub )")
    .in("id", dealIds);
  const reenrollDays = campaign.settings.reenroll_after_days ?? 60;
  const out: EnrollResult[] = [];
  for (const d of (deals ?? []) as any[]) {
    const c = d.crm_contacts;
    if (d.status !== "open") { out.push({ dealId: d.id, ok: false, reason: "deal not open" }); continue; }
    if (!c) { out.push({ dealId: d.id, ok: false, reason: "no contact" }); continue; }
    if (c.dnc) { out.push({ dealId: d.id, ok: false, reason: "contact is DNC" }); continue; }
    if (campaign.channel === "email" && c.email_unsub) { out.push({ dealId: d.id, ok: false, reason: "opted out of email" }); continue; }
    if (campaign.channel === "sms" && c.sms_consent === "opted_out") { out.push({ dealId: d.id, ok: false, reason: "texted STOP" }); continue; }
    if (campaign.channel === "sms" && c.sms_consent === "declined") { out.push({ dealId: d.id, ok: false, reason: "declined texts" }); continue; }
    const to = contactAddress(c, campaign.channel);
    if (!to) { out.push({ dealId: d.id, ok: false, reason: campaign.channel === "email" ? "no email on contact" : "no usable phone" }); continue; }
    // Sender = deal owner, else the rep the pool deal is checked out to.
    let owner = await dealOwnerEmail(db, d);
    if (!owner) {
      const { data: co } = await db.from("crm_reprospect_checkouts").select("rep_email").eq("deal_id", d.id).is("released_at", null).gt("expires_at", iso(Date.now())).limit(1).maybeSingle();
      owner = co?.rep_email ?? null;
    }
    if (!owner) { out.push({ dealId: d.id, ok: false, reason: "deal has no owner and isn't checked out (pool)" }); continue; }
    if (campaign.channel === "email") {
      const { data: g } = await db.from("gmail_accounts").select("status").eq("user_email", owner).maybeSingle();
      if (!g || g.status !== "active") { out.push({ dealId: d.id, ok: false, reason: `${owner.split("@")[0]} has no connected Gmail` }); continue; }
    } else {
      const { data: r } = await db.from("reps").select("telnyx_number").eq("email", owner).maybeSingle();
      if (!r?.telnyx_number) { out.push({ dealId: d.id, ok: false, reason: `${owner.split("@")[0]} has no texting number` }); continue; }
    }
    // One active campaign per deal per channel; no quick re-entry to the same campaign.
    const { data: existing } = await db
      .from("campaign_enrollments")
      .select("id, campaign_id, status, exited_at, campaigns ( channel )")
      .eq("deal_id", d.id);
    const activeSameChannel = (existing ?? []).find((e: any) => e.status === "active" && e.campaigns?.channel === campaign.channel);
    if (activeSameChannel) { out.push({ dealId: d.id, ok: false, reason: activeSameChannel.campaign_id === campaign.id ? "already enrolled" : `already in another ${campaign.channel} campaign` }); continue; }
    const prior = (existing ?? []).find((e: any) => e.campaign_id === campaign.id);
    if (prior && prior.status === "active") { out.push({ dealId: d.id, ok: false, reason: "already enrolled" }); continue; }
    // Re-entry gate: entries are logged as "📣 Enrolled in campaign" activities.
    const reMax = Math.max(1, campaign.settings.reentry_max ?? 1);
    const reDays = Math.max(1, campaign.settings.reentry_days ?? reenrollDays);
    const { count: entries } = await db.from("crm_activities").select("id", { count: "exact", head: true })
      .eq("deal_id", d.id).eq("type", "system").like("subject", "📣 Enrolled in campaign%")
      .eq("meta->>campaign_id", campaign.id).gte("occurred_at", iso(Date.now() - hours(24 * reDays)));
    if ((entries ?? 0) >= reMax) { out.push({ dealId: d.id, ok: false, reason: `entered ${entries}× in the last ${reDays}d (limit ${reMax})` }); continue; }
    const row = {
      campaign_id: campaign.id, deal_id: d.id, contact_id: c.id, owner_email: owner, status: "active", current_step: 0,
      next_step_at: iso(Date.now() + hours(firstDelay)), enrolled_at: new Date().toISOString(), enrolled_by: by, exited_at: null, exit_reason: null, hold_reason: null, last_send_at: null,
    };
    const { error } = prior
      ? await db.from("campaign_enrollments").update(row).eq("id", prior.id)
      : await db.from("campaign_enrollments").insert(row);
    if (error) { out.push({ dealId: d.id, ok: false, reason: error.message }); continue; }
    await db.from("crm_activities").insert({
      deal_id: d.id, contact_id: c.id, type: "system", subject: `📣 Enrolled in campaign "${campaign.name}"`,
      body: `Sends will come from ${owner} after approval in the Outbox.`, actor: by, occurred_at: new Date().toISOString(), meta: { campaign_id: campaign.id },
    });
    out.push({ dealId: d.id, ok: true });
  }
  return out;
}

/**
 * Deals a state-trigger campaign would enroll RIGHT NOW (eligible, not active
 * in it, under the re-entry gate). Used by the cron and by the builder's
 * "test on a deal this would enroll" preview, so both see the same people.
 */
export async function stateTriggerCandidates(db: SupabaseClient, c: Pick<Campaign, "id" | "channel" | "trigger" | "settings">, limit = 100): Promise<string[]> {
  const t = c.trigger ?? { type: "manual" };
  // Source / pipeline filters run in SQL so the candidate cap can't drop matches.
  let q = db.from("crm_deals").select("id, owner_pipedrive_id, crm_contacts ( emails, phones, dnc, sms_consent, email_unsub )").eq("status", "open").order("updated_at", { ascending: false }).limit(2000);
  if (t.source) {
    const { data: src } = await db.from("deal_sources").select("id").ilike("name", t.source).maybeSingle();
    if (!src) return [];
    q = q.eq("source_id", src.id);
  }
  if (t.pipeline) {
    const { data: pl } = await db.from("crm_pipelines").select("id").ilike("name", t.pipeline).maybeSingle();
    const { data: st } = pl ? await db.from("crm_stages").select("id").eq("pipeline_id", pl.id) : { data: [] as any[] };
    const ids = (st ?? []).map((x: any) => x.id);
    if (!ids.length) return [];
    q = q.in("stage_id", ids);
  }
  if (t.min_attempts != null) q = q.gte("attempt_count", t.min_attempts);
  if (t.max_contacts != null) q = q.lte("contact_count", t.max_contacts);
  if (t.min_contacts != null) q = q.gte("contact_count", t.min_contacts);
  if (t.min_days_since_created != null) q = q.lte("created_at", iso(Date.now() - hours(24 * t.min_days_since_created)));
  if (t.min_days_since_activity != null) q = q.or(`last_activity_at.is.null,last_activity_at.lte.${iso(Date.now() - hours(24 * t.min_days_since_activity))}`);
  const { data: deals } = await q;
  let rows = (deals ?? []) as any[];
  if (t.assignment === "assigned" || t.assignment === "unassigned") {
    const { data: cos } = await db.from("crm_reprospect_checkouts").select("deal_id").is("released_at", null).gt("expires_at", iso(Date.now()));
    const checkedOut = new Set((cos ?? []).map((x: any) => x.deal_id));
    const isAssigned = (d: any) => d.owner_pipedrive_id != null || checkedOut.has(d.id);
    rows = rows.filter((d) => (t.assignment === "assigned" ? isAssigned(d) : !isAssigned(d)));
  }
  if (t.web_signal && rows.length) rows = await filterByWebSignal(db, rows, t);
  if (t.no_campaign_days != null && t.no_campaign_days > 0 && rows.length) {
    // Contact-level: a person with two deals still counts as messaged.
    const ch = t.no_campaign_channel ?? "sms";
    const since = iso(Date.now() - hours(24 * t.no_campaign_days));
    const { data: sent } = await db.from("campaign_sends").select("deal_id, contact_id").eq("channel", ch).eq("status", "sent").gte("sent_at", since).limit(20000);
    const recentDeals = new Set((sent ?? []).map((x: any) => x.deal_id).filter(Boolean));
    const recentContacts = new Set((sent ?? []).map((x: any) => x.contact_id).filter(Boolean));
    const { data: dc } = await db.from("crm_deals").select("id, contact_id").in("id", rows.map((d) => d.id).slice(0, 2000));
    const contactOf = new Map((dc ?? []).map((x: any) => [x.id, x.contact_id]));
    rows = rows.filter((d) => !recentDeals.has(d.id) && !recentContacts.has(contactOf.get(d.id)));
  }
  if (t.no_manual_days != null && t.no_manual_days > 0 && rows.length) {
    const ch = t.no_manual_channel ?? "any";
    const types = ch === "any" ? ["sms", "email"] : [ch];
    const since = iso(Date.now() - hours(24 * t.no_manual_days));
    const ids = rows.map((d) => d.id).slice(0, 2000);
    const { data: dc } = await db.from("crm_deals").select("id, contact_id").in("id", ids);
    const contactOf = new Map((dc ?? []).map((x: any) => [x.id, x.contact_id as string | null]));
    const contactIds = [...new Set([...contactOf.values()].filter(Boolean))] as string[];
    const touchedDeals = new Set<string>(), touchedContacts = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data: acts } = await db.from("crm_activities").select("deal_id, contact_id, meta").in("deal_id", ids.slice(i, i + 200)).in("type", types).like("actor", "%@%").gte("occurred_at", since).limit(5000);
      for (const a of acts ?? []) {
        if ((a as any).meta?.campaign_send_id || ["inbound", "internal"].includes((a as any).meta?.direction)) continue;
        if (a.deal_id) touchedDeals.add(a.deal_id);
        if (a.contact_id) touchedContacts.add(a.contact_id);
      }
    }
    for (let i = 0; i < contactIds.length; i += 200) {
      const { data: acts } = await db.from("crm_activities").select("contact_id, meta").in("contact_id", contactIds.slice(i, i + 200)).in("type", types).like("actor", "%@%").gte("occurred_at", since).limit(5000);
      for (const a of acts ?? []) if (!(a as any).meta?.campaign_send_id && !["inbound", "internal"].includes((a as any).meta?.direction) && a.contact_id) touchedContacts.add(a.contact_id);
    }
    rows = rows.filter((d) => !touchedDeals.has(d.id) && !touchedContacts.has(contactOf.get(d.id) ?? ""));
  }
  // Skip deals CURRENTLY active in this campaign; the re-entry gate is enforced in enrollDeals.
  const { data: activeRows } = await db.from("campaign_enrollments").select("deal_id").eq("campaign_id", c.id).eq("status", "active");
  const activeIds = new Set((activeRows ?? []).map((s: any) => s.deal_id));
  // Pre-screen what enrollDeals would reject anyway, so permanently-ineligible
  // deals (no phone, DNC, declined texts, gated) can't crowd out new ones.
  rows = rows.filter((d) => {
    const ct = d.crm_contacts;
    if (!ct || ct.dnc) return false;
    if (c.channel === "email" && ct.email_unsub) return false;
    if (c.channel === "sms" && (ct.sms_consent === "opted_out" || ct.sms_consent === "declined")) return false;
    if (t.has_phone === "yes" || t.has_phone === "no") {
      if ((t.has_phone === "yes") !== !!contactAddress(ct, "sms")) return false;
    }
    return !!contactAddress(ct, c.channel);
  });
  const reMax = Math.max(1, c.settings.reentry_max ?? 1);
  const reDays = Math.max(1, c.settings.reentry_days ?? c.settings.reenroll_after_days ?? 60);
  const entryCount = new Map<string, number>();
  const candIds = rows.map((d) => d.id).filter((id) => !activeIds.has(id));
  for (let i = 0; i < candIds.length; i += 200) {
    const { data: ents } = await db.from("crm_activities").select("deal_id").in("deal_id", candIds.slice(i, i + 200))
      .eq("type", "system").like("subject", "📣 Enrolled in campaign%").eq("meta->>campaign_id", c.id)
      .gte("occurred_at", iso(Date.now() - hours(24 * reDays)));
    for (const e of ents ?? []) entryCount.set(e.deal_id, (entryCount.get(e.deal_id) ?? 0) + 1);
  }
  return candIds.filter((id) => (entryCount.get(id) ?? 0) < reMax).slice(0, limit);
}

/** State triggers: campaigns that auto-enroll deals matching a condition (evaluated every cron pass). */
export async function evaluateStateTriggers(db: SupabaseClient, opts: { deadline?: number; perCampaign?: number } = {}): Promise<Record<string, { candidates: number; enrolled: number }>> {
  // Random order each pass, so one slow campaign can't keep starving the others.
  const { data: camps } = await db.from("campaigns").select("*").eq("status", "active");
  const order = [...((camps ?? []) as Campaign[])].sort(() => Math.random() - 0.5);
  const out: Record<string, { candidates: number; enrolled: number }> = {};
  for (const c of order) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const t = c.trigger ?? { type: "manual" };
    if (t.type !== "state") continue;
    const fresh = await stateTriggerCandidates(db, c, opts.perCampaign ?? 25);
    const res = fresh.length ? await enrollDeals(db, c, fresh, "campaign-trigger") : [];
    out[c.name] = { candidates: fresh.length, enrolled: res.filter((r) => r.ok).length };
  }
  return out;
}

/** Keep only deals whose contact has ≥ web_min_count site signals of the chosen kind within web_within_days. */
async function filterByWebSignal(db: SupabaseClient, rows: any[], t: CampaignTrigger): Promise<any[]> {
  const since = iso(Date.now() - hours(24 * (t.web_within_days ?? 7)));
  const need = Math.max(1, t.web_min_count ?? 1);
  const types = t.web_signal === "any_visit" ? ["active_on_site", "viewed_product", "viewed_builder", "viewed_financing"] : [t.web_signal!];
  const emailToDeals = new Map<string, Set<string>>();
  for (const d of rows) for (const e of ((d.crm_contacts?.emails as any[]) ?? [])) {
    const k = String(e?.value ?? "").toLowerCase();
    if (k) (emailToDeals.get(k) ?? emailToDeals.set(k, new Set()).get(k)!).add(d.id);
  }
  const emails = Array.from(emailToDeals.keys());
  const counts = new Map<string, Set<string>>(); // deal → distinct sessions
  for (let i = 0; i < emails.length; i += 150) {
    const { data } = await db
      .from("engagement_events")
      .select("person_email, meta")
      .eq("source", "site")
      .in("type", types)
      .in("person_email", emails.slice(i, i + 150))
      .gte("occurred_at", since)
      .limit(5000);
    for (const ev of data ?? []) {
      const sess = String((ev as any).meta?.session_id ?? (ev as any).occurred_at);
      for (const dealId of emailToDeals.get(String(ev.person_email).toLowerCase()) ?? []) {
        (counts.get(dealId) ?? counts.set(dealId, new Set()).get(dealId)!).add(sess);
      }
    }
  }
  return rows.filter((d) => (counts.get(d.id)?.size ?? 0) >= need);
}

// ── Exit / hold rules ───────────────────────────────────────────────────────

async function contactPhones(db: SupabaseClient, contactId: string | null): Promise<string[]> {
  if (!contactId) return [];
  const { data } = await db.from("crm_contacts").select("phones").eq("id", contactId).maybeSingle();
  return (((data?.phones as any[]) ?? []).map((p) => p.e164 ?? normalizePhone(p.value)).filter(Boolean) as string[]);
}

/** Inbound replies since `since` (email on the deal, or texts from the contact's numbers). Returns the newest body for opt-out detection. */
async function inboundSince(db: SupabaseClient, dealId: string, contactId: string | null, since: string): Promise<{ any: boolean; text: string }> {
  const [{ data: emails }, phones] = await Promise.all([
    db.from("crm_activities").select("body, subject").eq("deal_id", dealId).eq("type", "email").eq("meta->>direction", "inbound").gt("occurred_at", since).order("occurred_at", { ascending: false }).limit(3),
    contactPhones(db, contactId),
  ]);
  let texts: any[] = [];
  if (phones.length) {
    const { data } = await db.from("sms_messages").select("body").eq("direction", "incoming").in("peer_phone", phones).gt("sent_at", since).order("sent_at", { ascending: false }).limit(3);
    texts = data ?? [];
  }
  const text = [...(emails ?? []).map((e: any) => `${e.subject ?? ""} ${e.body ?? ""}`), ...texts.map((t) => t.body ?? "")].join("\n");
  return { any: (emails?.length ?? 0) + texts.length > 0, text };
}

/** Manual outbound touches by a rep since `since` — split into the owner's own and anyone else's. Campaign sends are excluded. */
async function manualSendsSince(db: SupabaseClient, dealId: string, contactId: string | null, owner: string, since: string): Promise<{ ownerAt: string | null; otherBy: string | null }> {
  const { data: acts } = await db
    .from("crm_activities")
    .select("actor, occurred_at, type, meta")
    .eq("deal_id", dealId)
    .in("type", ["email", "sms"])
    .gt("occurred_at", since)
    .like("actor", "%@%")
    .order("occurred_at", { ascending: false })
    .limit(20);
  let ownerAt: string | null = null;
  let otherBy: string | null = null;
  for (const a of (acts ?? []) as any[]) {
    if (a.meta?.direction === "inbound" || a.meta?.campaign_send_id) continue;
    if (a.actor === owner) ownerAt = ownerAt ?? a.occurred_at;
    else otherBy = otherBy ?? a.actor;
  }
  return { ownerAt, otherBy };
}

async function weeklyCapReached(db: SupabaseClient, contactId: string | null, channel: string): Promise<string | null> {
  if (!contactId) return null;
  const { data } = await db
    .from("campaign_sends")
    .select("sent_at")
    .eq("contact_id", contactId)
    .eq("channel", channel)
    .eq("status", "sent")
    .gt("sent_at", iso(Date.now() - hours(24 * 7)))
    .order("sent_at");
  const rows = data ?? [];
  if (rows.length < WEEKLY_CAP) return null;
  return iso(Date.parse(rows[0].sent_at) + hours(24 * 7)); // when the oldest send falls out of the window
}

/** Klaviyo activity proxy: ≥2 marketing-email opens in 24h means Klaviyo is already in their inbox — wait. */
async function klaviyoBusy(db: SupabaseClient, contactId: string | null): Promise<boolean> {
  if (!contactId) return false;
  const { data: c } = await db.from("crm_contacts").select("emails").eq("id", contactId).maybeSingle();
  const emails = (((c?.emails as any[]) ?? []).map((e) => String(e.value ?? "").toLowerCase()).filter(Boolean));
  if (!emails.length) return false;
  const { count } = await db
    .from("engagement_events")
    .select("id", { count: "exact", head: true })
    .in("person_email", emails)
    .eq("type", "email_open")
    .gt("occurred_at", iso(Date.now() - hours(24)));
  return (count ?? 0) >= 2;
}

/** Push a time into the contact's local send window (tz_offset hours; PT when unknown). */
export function intoWindow(atMs: number, tzOffset: number | null, win: { start: number; end: number }): number {
  const off = tzOffset ?? -7;
  const local = new Date(atMs + hours(off));
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  if (h >= win.start && h < win.end) return atMs;
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const nextStart = h < win.start ? day + hours(win.start) : day + hours(24 + win.start);
  return nextStart - hours(off);
}

// ── Advance: draft the next step into the Outbox ─────────────────────────────

export async function advanceEnrollments(db: SupabaseClient, opts: { deadline?: number } = {}): Promise<{ checked: number; drafted: number; exited: number; held: number }> {
  const out = { checked: 0, drafted: 0, exited: 0, held: 0 };
  const { data: enrs } = await db
    .from("campaign_enrollments")
    .select("*, campaigns ( * ), crm_deals ( id, status, owner_email, owner_pipedrive_id, title, truck_model, crm_contacts ( id, name, first_name, last_name, emails, phones, tz_offset, dnc, sms_consent, email_unsub ) )")
    .eq("status", "active")
    .lte("next_step_at", iso(Date.now() + hours(DRAFT_AHEAD_H)))
    .order("next_step_at")
    .limit(200);
  for (const e of (enrs ?? []) as any[]) {
    if (opts.deadline && Date.now() > opts.deadline) break; // AI drafting is slow — the rest wait for the next pass
    out.checked++;
    const camp = e.campaigns as Campaign;
    const deal = e.crm_deals;
    const contact = deal?.crm_contacts;
    const exit = async (reason: string) => {
      await db.from("campaign_enrollments").update({ status: "exited", exited_at: new Date().toISOString(), exit_reason: reason, hold_reason: null }).eq("id", e.id);
      await db.from("campaign_sends").update({ status: "skipped", error: `campaign exited: ${reason}` }).eq("enrollment_id", e.id).in("status", ["draft", "approved"]);
      if (deal?.id) await db.from("crm_activities").insert({ deal_id: deal.id, contact_id: contact?.id ?? null, type: "system", subject: `📣 Campaign "${camp.name}" ended — ${reason}`, actor: "campaign", occurred_at: new Date().toISOString(), meta: { campaign_id: camp.id } });
      out.exited++;
    };
    const hold = async (untilMs: number, reason: string) => {
      await db.from("campaign_enrollments").update({ next_step_at: iso(untilMs), hold_reason: reason }).eq("id", e.id);
      out.held++;
    };

    if (!camp || camp.status !== "active") { if (camp?.status === "archived") await exit("campaign archived"); continue; }
    if (!deal || deal.status !== "open") { await exit(`deal ${deal?.status ?? "missing"}`); continue; }
    if (contact?.dnc) { await exit("contact marked DNC"); continue; }
    if (camp.channel === "email" && contact?.email_unsub) { await exit("opted out of email"); continue; }
    if (camp.channel === "sms" && contact?.sms_consent === "opted_out") { await exit("texted STOP"); continue; }
    if (camp.channel === "sms" && contact?.sms_consent === "declined") { await exit("declined texts"); continue; }
    const owner = e.owner_email ?? (await dealOwnerEmail(db, deal));
    const currentOwner = await dealOwnerEmail(db, deal);
    if (currentOwner && owner && currentOwner !== owner) { await exit(`deal reassigned to ${currentOwner.split("@")[0]}`); continue; }
    if (!owner) { await exit("deal has no owner"); continue; }
    // A reprospect pool deal sends only WHILE it's checked out to the sender
    // (Kyle 10/26) — when the 3-day hold ends without the rep taking it over,
    // the campaign stops.
    if (!currentOwner) {
      const { data: co } = await db.from("crm_reprospect_checkouts").select("id").eq("deal_id", deal.id).eq("rep_email", owner).is("released_at", null).gt("expires_at", iso(Date.now())).limit(1).maybeSingle();
      if (!co) { await exit("checkout ended"); continue; }
    }

    const since = e.last_send_at ?? e.enrolled_at;
    const inbound = await inboundSince(db, deal.id, contact?.id ?? null, since);
    if (inbound.any && OPT_OUT_RE.test(inbound.text)) {
      if (camp.channel === "email" && contact?.id) await db.from("crm_contacts").update({ email_unsub: true, email_unsub_at: new Date().toISOString(), email_unsub_source: "reply keyword" }).eq("id", contact.id);
      await exit("customer asked to stop");
      continue;
    }
    if (inbound.any && (camp.settings?.exit_on_reply ?? true)) { await exit("customer replied"); continue; }
    const manual = await manualSendsSince(db, deal.id, contact?.id ?? null, owner, since);
    if (manual.otherBy && (camp.settings?.stop_on_other_rep ?? true)) { await exit(`${manual.otherBy.split("@")[0]} contacted them`); continue; }

    // Already drafted for this step? Then nothing to do until it's approved/sent.
    const { data: pending } = await db.from("campaign_sends").select("id").eq("enrollment_id", e.id).eq("step_position", e.current_step).in("status", ["draft", "approved"]).limit(1).maybeSingle();
    if (pending) continue;

    const { data: steps } = await db.from("campaign_steps").select("*").eq("campaign_id", camp.id).order("position");
    const step = (steps ?? [])[e.current_step] as CampaignStep | undefined;
    if (!step) {
      await db.from("campaign_enrollments").update({ status: "completed", exited_at: new Date().toISOString(), exit_reason: "all steps sent", hold_reason: null }).eq("id", e.id);
      continue;
    }

    // Holds: owner's own manual send (<24h), weekly cap, Klaviyo, contact window.
    let dueMs = Date.parse(e.next_step_at);
    if (manual.ownerAt) {
      const earliest = Date.parse(manual.ownerAt) + hours(OWNER_SEND_HOLD_H);
      if (earliest > dueMs) { await hold(earliest, `${owner.split("@")[0]} just reached out — waiting 24h`); continue; }
    }
    const capUntil = await weeklyCapReached(db, contact?.id ?? null, camp.channel);
    if (capUntil) { await hold(Date.parse(capUntil), "weekly send cap reached"); continue; }
    if (camp.channel === "email" && (await klaviyoBusy(db, contact?.id ?? null))) { await hold(Date.now() + hours(12), "Klaviyo emailed them twice today — waiting"); continue; }
    // Step conditions on the previous send's opens.
    if (e.current_step > 0 && (step.conditions?.skip_if_opened_prev || step.conditions?.only_if_opened_prev)) {
      const { data: prev } = await db.from("campaign_sends").select("track_token").eq("enrollment_id", e.id).eq("step_position", e.current_step - 1).eq("status", "sent").maybeSingle();
      let opened = false;
      if (prev?.track_token) {
        const { data: tr } = await db.from("email_tracking").select("first_open_at").eq("token", prev.track_token).maybeSingle();
        opened = !!tr?.first_open_at;
      }
      if ((step.conditions.skip_if_opened_prev && opened) || (step.conditions.only_if_opened_prev && !opened)) {
        await db.from("campaign_enrollments").update({ current_step: e.current_step + 1, next_step_at: iso(Date.now()), hold_reason: null }).eq("id", e.id);
        continue;
      }
    }
    const dflt = camp.channel === "sms" ? SMS_WINDOW : DEFAULT_WINDOW;
    const win = { start: camp.settings?.window_start ?? dflt.start, end: camp.settings?.window_end ?? dflt.end };
    // Phase 3: the hour this buyer actually opens email (their history), else a prior; weekdays only.
    const contactEmails = (((contact?.emails as any[]) ?? []).map((x) => String(x.value ?? "").toLowerCase()).filter(Boolean));
    const slot = await bestSendTime(db, { emails: contactEmails, tzOffset: contact?.tz_offset ?? null, window: win, notBefore: Math.max(dueMs, Date.now()) }).catch(() => null);
    const slotMs = slot?.at ?? intoWindow(Math.max(dueMs, Date.now()), contact?.tz_offset ?? null, win);

    // Content.
    const to = contactAddress(contact, camp.channel);
    if (!to) { await exit(camp.channel === "email" ? "no email on contact" : "no usable phone"); continue; }
    let subject = step.subject ?? "";
    let body = step.body ?? "";
    let generatedBy = "macro";
    let aiMeta: Record<string, unknown> | null = null;
    const { data: rep } = await db.from("reps").select("name").eq("email", owner).maybeSingle();
    const repName = rep?.name ?? owner.split("@")[0];
    if (step.content_kind === "macro" && step.macro_id) {
      const { data: m } = await db.from("comm_macros").select("subject, body").eq("id", step.macro_id).maybeSingle();
      subject = m?.subject ?? subject;
      body = m?.body ?? body;
    } else if (step.content_kind === "prompt") {
      // AI step: write this buyer's email from the step prompt + everything on the deal.
      if (!step.prompt?.trim()) { await hold(Date.now() + hours(6), "AI step has no prompt"); continue; }
      try {
        const { data: priorRows } = await db.from("campaign_sends").select("step_position, subject, body, sent_at, track_token").eq("enrollment_id", e.id).eq("status", "sent").order("step_position");
        const tokens = (priorRows ?? []).map((p: any) => p.track_token).filter(Boolean);
        const { data: opens } = tokens.length ? await db.from("email_tracking").select("token, first_open_at").in("token", tokens) : { data: [] as any[] };
        const openedBy = new Set((opens ?? []).filter((o: any) => o.first_open_at).map((o: any) => o.token));
        const { generateCampaignEmail } = await import("./campaign-ai");
        const gen = await generateCampaignEmail(db, {
          channel: camp.channel,
          dealId: deal.id, campaignName: camp.name, stepPosition: e.current_step, stepCount: (steps ?? []).length,
          prompt: step.prompt, steering: step.steering, repName, ownerEmail: owner,
          priorSends: (priorRows ?? []).map((p: any) => ({ step: p.step_position + 1, subject: p.subject, body: p.body, sentAt: p.sent_at, opened: openedBy.has(p.track_token) })),
        });
        subject = gen.subject;
        body = gen.body;
        generatedBy = "ai";
        aiMeta = { model: gen.model, rationale: gen.rationale, warnings: gen.warnings, prompt_hash: step.prompt.length };
      } catch (err) {
        await hold(Date.now() + hours(6), `AI draft failed: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
        continue;
      }
    }
    const vals = { firstName: contact?.first_name ?? null, lastName: contact?.last_name ?? null, name: contact?.name ?? null, dealTitle: deal.title ?? null, truck: deal.truck_model ?? null, repName };
    subject = fillPlaceholders(subject, vals).trim();
    body = fillPlaceholders(body, vals).trim();
    if (!body || (camp.channel === "email" && !subject)) { await hold(Date.now() + hours(6), "step has no content"); continue; }

    // Written (macro) steps are the rep's own words — they send on schedule
    // without Outbox approval. AI-written steps always wait for a human
    // (Kyle 9/24).
    const autoApprove = generatedBy !== "ai";
    const { error } = await db.from("campaign_sends").insert({
      enrollment_id: e.id, campaign_id: camp.id, step_id: step.id, step_position: e.current_step, deal_id: deal.id, contact_id: contact?.id ?? null,
      owner_email: owner, channel: camp.channel, to_address: to, subject: camp.channel === "email" ? subject : null, body, generated_by: generatedBy,
      status: autoApprove ? "approved" : "draft", scheduled_for: iso(slotMs),
      ...(aiMeta ? { ai_meta: { ...aiMeta, timing: slot ? { hour: slot.hour, basis: slot.basis, opens: slot.opens } : null } } : {}),
      ...(autoApprove ? { approved_by: "auto", approved_at: new Date().toISOString() } : {}),
    });
    if (!error) {
      await db.from("campaign_enrollments").update({ hold_reason: null }).eq("id", e.id);
      out.drafted++;
    }
  }
  return out;
}

// ── Send approved items that are due ─────────────────────────────────────────

export async function sendDue(db: SupabaseClient, opts: { limit?: number } = {}): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  const { data: due } = await db
    .from("campaign_sends")
    .select("*, campaign_enrollments ( id, current_step, campaign_id ), campaigns ( name, channel )")
    .eq("status", "approved")
    .lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for")
    .limit(opts.limit ?? 25);
  for (const s of (due ?? []) as any[]) {
    // Pool deal: send only while it's still checked out to the sender.
    if (s.deal_id) {
      const { data: dl } = await db.from("crm_deals").select("owner_pipedrive_id, owner_email").eq("id", s.deal_id).maybeSingle();
      if (dl && dl.owner_pipedrive_id == null && !dl.owner_email) {
        const { data: co } = await db.from("crm_reprospect_checkouts").select("id").eq("deal_id", s.deal_id).eq("rep_email", s.owner_email).is("released_at", null).gt("expires_at", iso(Date.now())).limit(1).maybeSingle();
        if (!co) {
          await db.from("campaign_sends").update({ status: "skipped", error: "checkout ended before send" }).eq("id", s.id);
          if (s.enrollment_id) await db.from("campaign_enrollments").update({ status: "exited", exited_at: iso(Date.now()), exit_reason: "checkout ended" }).eq("id", s.enrollment_id).eq("status", "active");
          continue;
        }
      }
    }
    try {
      const meta = { campaign_id: s.campaign_id, campaign_send_id: s.id, campaign_step: s.step_position + 1 };
      const r = s.channel === "sms"
        ? { ...(await sendTrackedSms(db, { actorEmail: s.owner_email, to: s.to_address, body: s.body, dealId: s.deal_id, contactId: s.contact_id, meta })), trackToken: null as string | null }
        : await sendTrackedEmail(db, { actorEmail: s.owner_email, to: s.to_address, subject: s.subject, body: s.body, dealId: s.deal_id, contactId: s.contact_id, meta });
      const now = new Date().toISOString();
      await db.from("campaign_sends").update({ status: "sent", sent_at: now, activity_id: r.activityId, track_token: r.trackToken }).eq("id", s.id);
      // Learning loop: an AI send is a "used" draft — with how much the rep
      // changed it — so the weekly draft critic proposes style rules from
      // real corrections (theme key = campaign:<id>).
      if (s.generated_by === "ai") {
        const original = s.original_body ?? s.body;
        await db.from("draft_events").insert({
          deal_id: s.deal_id, kind: s.channel === "sms" ? "sms" : "email", theme_key: `campaign:${s.campaign_id}`, direction: `step ${s.step_position + 1}`, rep: s.owner_email,
          draft_body: String(original).slice(0, 4000), generated_at: s.created_at, used_at: s.approved_at ?? now,
          sent_activity_id: r.activityId, sent_similarity: s.edited ? draftSimilarity(String(original), String(s.body)) : 1,
        }).then(() => {}, () => {});
      }
      // Advance the enrollment: next step's delay counts from this send.
      const { data: next } = await db.from("campaign_steps").select("delay_hours").eq("campaign_id", s.campaign_id).eq("position", s.step_position + 1).maybeSingle();
      await db
        .from("campaign_enrollments")
        .update({ current_step: s.step_position + 1, last_send_at: now, next_step_at: next ? iso(Date.now() + hours(next.delay_hours)) : now, hold_reason: null })
        .eq("id", s.enrollment_id);
      out.sent++;
    } catch (err) {
      await db.from("campaign_sends").update({ status: "failed", error: err instanceof Error ? err.message.slice(0, 300) : String(err) }).eq("id", s.id);
      out.failed++;
    }
  }
  return out;
}
