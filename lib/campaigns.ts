import type { SupabaseClient } from "@supabase/supabase-js";
import { fillPlaceholders } from "./placeholders";
import { sendTrackedEmail } from "./email-send";
import { normalizePhone } from "./identity";

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
export const DEFAULT_WINDOW = { start: 9, end: 17 }; // contact-local hours
const OPT_OUT_RE = /\b(unsubscribe|opt[ -]?out|remove me|stop (emailing|texting|contacting|messaging)|don'?t (email|text|contact|message) me|take me off)\b/i;

export interface CampaignTrigger {
  type: "manual" | "state";
  source?: string | null; // deal_sources.name
  min_attempts?: number | null;
  max_contacts?: number | null; // e.g. 0 = never had a conversation
  min_days_since_created?: number | null;
  min_days_since_activity?: number | null;
  pipeline?: string | null; // crm_pipelines.name
}
export interface CampaignSettings {
  window_start?: number; // contact-local hour
  window_end?: number;
  exit_on_reply?: boolean; // default true
  stop_on_other_rep?: boolean; // default true
  reenroll_after_days?: number; // default 60: exited/completed deals can't re-enter sooner
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
    const to = contactAddress(c, campaign.channel);
    if (!to) { out.push({ dealId: d.id, ok: false, reason: campaign.channel === "email" ? "no email on contact" : "no usable phone" }); continue; }
    const owner = await dealOwnerEmail(db, d);
    if (!owner) { out.push({ dealId: d.id, ok: false, reason: "deal has no owner (pool)" }); continue; }
    if (campaign.channel === "email") {
      const { data: g } = await db.from("gmail_accounts").select("status").eq("user_email", owner).maybeSingle();
      if (!g || g.status !== "active") { out.push({ dealId: d.id, ok: false, reason: `${owner.split("@")[0]} has no connected Gmail` }); continue; }
    }
    // One active campaign per deal per channel; no quick re-entry to the same campaign.
    const { data: existing } = await db
      .from("campaign_enrollments")
      .select("id, campaign_id, status, exited_at, campaigns ( channel )")
      .eq("deal_id", d.id);
    const activeSameChannel = (existing ?? []).find((e: any) => e.status === "active" && e.campaigns?.channel === campaign.channel);
    if (activeSameChannel) { out.push({ dealId: d.id, ok: false, reason: activeSameChannel.campaign_id === campaign.id ? "already enrolled" : `already in another ${campaign.channel} campaign` }); continue; }
    const prior = (existing ?? []).find((e: any) => e.campaign_id === campaign.id);
    if (prior && prior.exited_at && Date.now() - Date.parse(prior.exited_at) < hours(24 * reenrollDays)) {
      out.push({ dealId: d.id, ok: false, reason: `was in this campaign <${reenrollDays}d ago` });
      continue;
    }
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

/** State triggers: campaigns that auto-enroll deals matching a condition (evaluated every cron pass). */
export async function evaluateStateTriggers(db: SupabaseClient): Promise<Record<string, { candidates: number; enrolled: number }>> {
  const { data: camps } = await db.from("campaigns").select("*").eq("status", "active");
  const out: Record<string, { candidates: number; enrolled: number }> = {};
  for (const c of (camps ?? []) as Campaign[]) {
    const t = c.trigger ?? { type: "manual" };
    if (t.type !== "state") continue;
    let q = db.from("crm_deals").select("id, source_id, deal_sources ( name ), crm_stages ( crm_pipelines ( name ) )").eq("status", "open").limit(500);
    if (t.min_attempts != null) q = q.gte("attempt_count", t.min_attempts);
    if (t.max_contacts != null) q = q.lte("contact_count", t.max_contacts);
    if (t.min_days_since_created != null) q = q.lte("created_at", iso(Date.now() - hours(24 * t.min_days_since_created)));
    if (t.min_days_since_activity != null) q = q.or(`last_activity_at.is.null,last_activity_at.lte.${iso(Date.now() - hours(24 * t.min_days_since_activity))}`);
    const { data: deals } = await q;
    let rows = (deals ?? []) as any[];
    if (t.source) rows = rows.filter((d) => String(d.deal_sources?.name ?? "").toLowerCase() === String(t.source).toLowerCase());
    if (t.pipeline) rows = rows.filter((d) => String(d.crm_stages?.crm_pipelines?.name ?? "").toLowerCase() === String(t.pipeline).toLowerCase());
    // Skip deals already enrolled in this campaign (any status — the re-enroll window is enforced inside enrollDeals).
    const { data: seen } = await db.from("campaign_enrollments").select("deal_id").eq("campaign_id", c.id);
    const seenIds = new Set((seen ?? []).map((s: any) => s.deal_id));
    const fresh = rows.filter((d) => !seenIds.has(d.id)).map((d) => d.id).slice(0, 100);
    const res = fresh.length ? await enrollDeals(db, c, fresh, "campaign-trigger") : [];
    out[c.name] = { candidates: fresh.length, enrolled: res.filter((r) => r.ok).length };
  }
  return out;
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

export async function advanceEnrollments(db: SupabaseClient): Promise<{ checked: number; drafted: number; exited: number; held: number }> {
  const out = { checked: 0, drafted: 0, exited: 0, held: 0 };
  const { data: enrs } = await db
    .from("campaign_enrollments")
    .select("*, campaigns ( * ), crm_deals ( id, status, owner_email, owner_pipedrive_id, title, truck_model, crm_contacts ( id, name, first_name, last_name, emails, phones, tz_offset, dnc, sms_consent, email_unsub ) )")
    .eq("status", "active")
    .lte("next_step_at", iso(Date.now() + hours(DRAFT_AHEAD_H)))
    .limit(200);
  for (const e of (enrs ?? []) as any[]) {
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
    const owner = e.owner_email ?? (await dealOwnerEmail(db, deal));
    const currentOwner = await dealOwnerEmail(db, deal);
    if (currentOwner && owner && currentOwner !== owner) { await exit(`deal reassigned to ${currentOwner.split("@")[0]}`); continue; }
    if (!owner) { await exit("deal has no owner"); continue; }

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
    const win = { start: camp.settings?.window_start ?? DEFAULT_WINDOW.start, end: camp.settings?.window_end ?? DEFAULT_WINDOW.end };
    const slotMs = intoWindow(Math.max(dueMs, Date.now()), contact?.tz_offset ?? null, win);

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
          dealId: deal.id, campaignName: camp.name, stepPosition: e.current_step, stepCount: (steps ?? []).length,
          prompt: step.prompt, steering: step.steering, repName,
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
      owner_email: owner, channel: camp.channel, to_address: to, subject: camp.channel === "email" ? subject : null, body, generated_by: generatedBy, ai_meta: aiMeta,
      status: autoApprove ? "approved" : "draft", scheduled_for: iso(slotMs),
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
    try {
      if (s.channel !== "email") throw new Error("SMS campaigns ship in Phase 4");
      const r = await sendTrackedEmail(db, {
        actorEmail: s.owner_email, to: s.to_address, subject: s.subject, body: s.body, dealId: s.deal_id, contactId: s.contact_id,
        meta: { campaign_id: s.campaign_id, campaign_send_id: s.id, campaign_step: s.step_position + 1 },
      });
      const now = new Date().toISOString();
      await db.from("campaign_sends").update({ status: "sent", sent_at: now, activity_id: r.activityId, track_token: r.trackToken }).eq("id", s.id);
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
