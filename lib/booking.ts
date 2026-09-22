import type { SupabaseClient } from "@supabase/supabase-js";
import { findContact, normEmail, normPhone } from "./intake";

/**
 * "Schedule with a Gravel Guide" — the native Calendly replacement.
 *
 * Availability is generated from one config (PT business hours, slot length,
 * minimum notice, horizon) minus each rep's existing bookings and timed
 * activities. Times are computed in Pacific and returned as UTC instants; the
 * customer's browser renders them in whatever zone they pick.
 */

export const REP_TZ = "America/Los_Angeles";
export const APP_URL = "https://lpo-sales-engine.vercel.app";
export const SENDER_EMAIL = "cainen@lonepeakoverland.com";
export const BOOKING_SOURCE = "Gravel Guide Call";

/** Public base for booking links: the custom domain when configured (e.g.
 * https://book.lonepeakoverland.com, served by the middleware host rewrite),
 * else the app's /book path. */
export function bookingBase(): string {
  return (process.env.BOOKING_BASE_URL ?? `${APP_URL}/book`).replace(/\/$/, "");
}
export const repBookingUrl = (slug: string) => `${bookingBase()}/${slug}`;
export const manageBookingUrl = (token: string) => `${bookingBase()}/manage/${token}`;

export interface EmailTemplate {
  subject: string;
  body: string;
}

/** The three things a customer can book. */
export type BookingKind = "call" | "confirm" | "showroom";
export const BOOKING_KINDS: BookingKind[] = ["call", "confirm", "showroom"];
export const SHOWROOM_ADDRESS = "13 Pangborn Rd, East Wenatchee, WA 98802";

export const KIND_META: Record<
  BookingKind,
  { label: string; blurb: string; noun: string; activityType: "call" | "meeting"; emoji: string; activitySubject: (name: string) => string; alertTitle: string }
> = {
  call: {
    label: "Gravel Guide Call",
    blurb: "Talk through your build, options and questions with one of our guides.",
    noun: "call",
    activityType: "call",
    emoji: "📅",
    activitySubject: (n) => `📅 Scheduled call — ${n}`,
    alertTitle: "New call booked",
  },
  confirm: {
    label: "Confirm Your Order",
    blurb: "Already placed a deposit? Book a time to finalize your build together.",
    noun: "order confirmation call",
    activityType: "call",
    emoji: "✅",
    activitySubject: (n) => `✅ Order confirmation call — ${n}`,
    alertTitle: "Order confirmation booked",
  },
  showroom: {
    label: "Showroom Appointment",
    blurb: `See the campers in person at our shop — ${SHOWROOM_ADDRESS}.`,
    noun: "showroom visit",
    activityType: "meeting",
    emoji: "🏠",
    activitySubject: (n) => `🏠 Showroom appointment — ${n}`,
    alertTitle: "Showroom appointment booked",
  },
};
export const isBookingKind = (k: unknown): k is BookingKind => typeof k === "string" && (BOOKING_KINDS as string[]).includes(k);

export type ConfirmationMap = Partial<Record<BookingKind, EmailTemplate>>;

export interface BookingConfig {
  slot_minutes: number;
  days: number[]; // 0=Sun … 6=Sat, in PT
  start: string; // "HH:MM" PT
  end: string; // "HH:MM" PT
  min_notice_hours: number;
  horizon_days: number;
  confirmation?: EmailTemplate; // legacy single template (= the 'call' default)
  confirmations?: ConfirmationMap; // team-default customer confirmation PER TYPE (guides may override)
}

/** Placeholders every confirmation template can use. */
export const TEMPLATE_VARS = ["first_name", "name", "when", "date", "time", "phone", "rep_first", "rep_name", "address"] as const;

// Sent FROM the guide, so they speak in first person. The reschedule/cancel
// link is appended automatically — it is never part of the editable text.
export const DEFAULT_CONFIRMATIONS: Record<BookingKind, EmailTemplate> = {
  call: {
    subject: "Thanks for booking a call with me — {{when}}",
    body: [
      "Hi {{first_name}},",
      "",
      "Thanks for booking a call with me! I'm looking forward to talking through your build and answering any questions you have.",
      "",
      "When: {{when}}",
      "I'll call you at {{phone}}.",
      "",
      "If anything comes up before then, just reply to this email.",
      "",
      "Talk soon,",
      "{{rep_name}}",
      "Lone Peak Overland",
    ].join("\n"),
  },
  confirm: {
    subject: "Thanks for scheduling your order confirmation — {{when}}",
    body: [
      "Hi {{first_name}},",
      "",
      "Thanks for booking a time with me to confirm your order! On our call I'll help you finalize your build — we'll go through every option together and make sure it's exactly what you want before it's locked in.",
      "",
      "When: {{when}}",
      "I'll call you at {{phone}}.",
      "",
      "If there's anything you'd like to look over beforehand, just reply to this email and I'll send it your way.",
      "",
      "Talk soon,",
      "{{rep_name}}",
      "Lone Peak Overland",
    ].join("\n"),
  },
  showroom: {
    subject: "See you at the showroom — {{when}}",
    body: [
      "Hi {{first_name}},",
      "",
      "Thanks for setting up a showroom visit! I'll see you on {{when}} at our shop:",
      "",
      "Lone Peak Overland",
      "{{address}}",
      "",
      "You'll get to walk through the campers in person, and we can talk through your build while you're here. If anything changes, just reply to this email.",
      "",
      "See you then,",
      "{{rep_name}}",
      "Lone Peak Overland",
    ].join("\n"),
  },
};
/** @deprecated single-template alias kept for older callers. */
export const DEFAULT_CONFIRMATION = DEFAULT_CONFIRMATIONS.call;

/** Parse a stored template value: a per-kind map, or a legacy single {subject, body} (= call). */
export function parseTemplates(v: unknown): ConfirmationMap | null {
  if (!v || typeof v !== "object") return null;
  const o = v as any;
  if (typeof o.subject === "string" && typeof o.body === "string") return { call: { subject: o.subject, body: o.body } };
  const out: ConfirmationMap = {};
  for (const k of BOOKING_KINDS) {
    if (o[k] && typeof o[k].subject === "string" && typeof o[k].body === "string" && o[k].subject.trim() && o[k].body.trim()) out[k] = { subject: o[k].subject, body: o[k].body };
  }
  return Object.keys(out).length ? out : null;
}

export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (k in vars ? vars[k] : m));
}

export const DEFAULT_CONFIG: BookingConfig = {
  slot_minutes: 30,
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00",
  min_notice_hours: 2,
  horizon_days: 21,
};

export async function loadBookingConfig(db: SupabaseClient): Promise<BookingConfig> {
  const { data } = await db.from("crm_sync_state").select("value").eq("key", "booking_config").maybeSingle();
  return { ...DEFAULT_CONFIG, ...((data?.value as Partial<BookingConfig>) ?? {}) };
}

/** A rep's own override of the team defaults; any field absent = team value. */
export interface RepHours {
  days?: number[];
  start?: string;
  end?: string;
  blocked?: string[]; // days off, YYYY-MM-DD in Pacific
}

export interface BookableRep {
  id: string;
  name: string;
  first: string;
  email: string;
  slug: string;
  pipedriveUserId: number | null;
  hours: RepHours | null;
  emailTemplates: ConfirmationMap | null; // the guide's own confirmations per type; missing = team default
}

export async function bookableReps(db: SupabaseClient): Promise<BookableRep[]> {
  const { data } = await db
    .from("reps")
    .select("id, name, email, booking_slug, pipedrive_user_id, sort_order, booking_hours, booking_email")
    .eq("active", true)
    .eq("booking_enabled", true)
    .not("booking_slug", "is", null)
    .not("email", "is", null)
    .order("sort_order")
    .order("name");
  return (data ?? []).map((r: any) => ({
    id: r.id,
    name: r.name,
    first: String(r.name).split(/\s+/)[0],
    email: r.email,
    slug: r.booking_slug,
    pipedriveUserId: r.pipedrive_user_id ?? null,
    hours: (r.booking_hours as RepHours | null) ?? null,
    emailTemplates: parseTemplates(r.booking_email),
  }));
}

/** Team-default templates per type (legacy single `confirmation` = the call one). */
export function teamTemplates(cfg: BookingConfig): Record<BookingKind, EmailTemplate> {
  const team = parseTemplates(cfg.confirmations) ?? {};
  const legacy = parseTemplates(cfg.confirmation) ?? {};
  return {
    call: team.call ?? legacy.call ?? DEFAULT_CONFIRMATIONS.call,
    confirm: team.confirm ?? DEFAULT_CONFIRMATIONS.confirm,
    showroom: team.showroom ?? DEFAULT_CONFIRMATIONS.showroom,
  };
}

/** The confirmation a given guide sends for a booking type: their own, else the team's, else the built-in. */
export function confirmationTemplate(cfg: BookingConfig, rep: BookableRep, kind: BookingKind): EmailTemplate {
  return rep.emailTemplates?.[kind] ?? teamTemplates(cfg)[kind];
}

/** Team config with the rep's own hours layered on, plus their days off. */
export function effectiveFor(cfg: BookingConfig, rep: BookableRep): { cfg: BookingConfig; blocked: Set<string> } {
  const h = rep.hours ?? {};
  return {
    cfg: {
      ...cfg,
      days: h.days && h.days.length ? h.days : cfg.days,
      start: h.start ?? cfg.start,
      end: h.end ?? cfg.end,
    },
    blocked: new Set(h.blocked ?? []),
  };
}

// ── Time-zone math (no dependencies) ────────────────────────────────────────

/** Offset (ms) of `tz` from UTC at the given instant. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return asUtc - utcMs;
}

/** UTC instant for a wall-clock date + time in `tz` (DST-correct). */
export function zonedToUtc(date: string, time: string, tz: string): number {
  const guess = Date.parse(`${date}T${time}:00Z`);
  let utc = guess - tzOffsetMs(guess, tz);
  const off2 = tzOffsetMs(utc, tz);
  if (guess - off2 !== utc) utc = guess - off2;
  return utc;
}

/** YYYY-MM-DD of an instant in `tz`. */
export function dateIn(utcMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(utcMs));
}

export function fmtIn(utcMs: number, tz: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...opts }).format(new Date(utcMs));
}

// ── Availability ────────────────────────────────────────────────────────────

/** Every candidate slot start (UTC ms) inside the config window from now,
 * skipping any `blocked` Pacific dates (a rep's days off). */
export function candidateSlots(cfg: BookingConfig, now = Date.now(), blocked?: Set<string>): number[] {
  const out: number[] = [];
  const earliest = now + cfg.min_notice_hours * 3600_000;
  const startDay = dateIn(now, REP_TZ);
  for (let i = 0; i <= cfg.horizon_days; i++) {
    const dayMs = Date.parse(`${startDay}T12:00:00Z`) + i * 86_400_000;
    const date = new Date(dayMs).toISOString().slice(0, 10);
    const dow = new Date(dayMs).getUTCDay();
    if (!cfg.days.includes(dow)) continue;
    if (blocked?.has(date)) continue;
    const open = zonedToUtc(date, cfg.start, REP_TZ);
    const close = zonedToUtc(date, cfg.end, REP_TZ);
    for (let t = open; t + cfg.slot_minutes * 60_000 <= close; t += cfg.slot_minutes * 60_000) {
      if (t >= earliest) out.push(t);
    }
  }
  return out;
}

/** Slot starts (UTC ms) a rep is NOT free for: existing bookings + timed activities. */
async function busySlots(db: SupabaseClient, rep: BookableRep, slots: number[], slotMs: number): Promise<Set<number>> {
  if (slots.length === 0) return new Set();
  const from = new Date(slots[0]).toISOString();
  const to = new Date(slots[slots.length - 1] + slotMs).toISOString();
  const [{ data: bookings }, { data: acts }] = await Promise.all([
    db.from("bookings").select("start_at, end_at").eq("rep_id", rep.id).eq("status", "booked").gte("end_at", from).lte("start_at", to),
    db
      .from("crm_activities")
      .select("due_at")
      .eq("actor", rep.email)
      .is("done_at", null)
      .gte("due_at", from)
      .lte("due_at", to),
  ]);
  const busy = new Set<number>();
  const blocks: [number, number][] = [];
  for (const b of bookings ?? []) blocks.push([Date.parse(b.start_at), Date.parse(b.end_at)]);
  for (const a of acts ?? []) {
    const t = Date.parse(a.due_at);
    // All-day tasks (00:00Z convention) don't occupy a clock slot.
    if (a.due_at.endsWith("T00:00:00.000Z") || a.due_at.endsWith("T00:00:00+00:00")) continue;
    blocks.push([t, t + slotMs]);
  }
  for (const s of slots) {
    const e = s + slotMs;
    if (blocks.some(([bs, be]) => s < be && e > bs)) busy.add(s);
  }
  return busy;
}

/** Available slots for one rep, or (rr) the union across all bookable reps. */
export async function availableSlots(
  db: SupabaseClient,
  target: { rep?: BookableRep; reps?: BookableRep[] },
  cfg: BookingConfig
): Promise<number[]> {
  const slotMs = cfg.slot_minutes * 60_000;
  const reps = target.rep ? [target.rep] : target.reps ?? [];
  if (reps.length === 0) return [];
  // Each rep offers their OWN hours (team defaults unless they've set their
  // own) minus their days off and existing commitments; round robin = union.
  const perRep = await Promise.all(
    reps.map(async (r) => {
      const eff = effectiveFor(cfg, r);
      const cands = candidateSlots(eff.cfg, Date.now(), eff.blocked);
      const busy = await busySlots(db, r, cands, slotMs);
      return cands.filter((s) => !busy.has(s));
    })
  );
  return [...new Set(perRep.flat())].sort((a, b) => a - b);
}

/** Round robin: next rep in rotation who is free at `slot`. Advances the pointer. */
export async function pickRoundRobin(db: SupabaseClient, reps: BookableRep[], slot: number, cfg: BookingConfig): Promise<BookableRep | null> {
  if (reps.length === 0) return null;
  const { data } = await db.from("crm_sync_state").select("value").eq("key", "booking_rr").maybeSingle();
  const last = Number((data?.value as any)?.idx ?? -1);
  const slotMs = cfg.slot_minutes * 60_000;
  for (let step = 1; step <= reps.length; step++) {
    const idx = (last + step) % reps.length;
    const rep = reps[idx];
    const eff = effectiveFor(cfg, rep);
    if (!candidateSlots(eff.cfg, Date.now(), eff.blocked).includes(slot)) continue; // outside this rep's hours / a day off
    const busy = await busySlots(db, rep, [slot], slotMs);
    if (busy.has(slot)) continue;
    await db.from("crm_sync_state").upsert({ key: "booking_rr", value: { idx }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    return rep;
  }
  return null;
}

// ── Booking creation ────────────────────────────────────────────────────────

export interface BookingRequest {
  name: string;
  email: string | null;
  phone: string | null;
  tz: string;
  note: string | null;
  startAt: number; // UTC ms
  via: "direct" | "round_robin";
  kind: BookingKind;
  rebookToken?: string | null; // reschedule: cancel this prior booking once the new one exists
}

async function defaultStageId(db: SupabaseClient): Promise<string | null> {
  // New booking-created deals start where intake leads start: the Prospecting
  // Pipeline's intake stage.
  const { data } = await db
    .from("crm_stages")
    .select("id, name, crm_pipelines ( name )")
    .ilike("name", "%intake%")
    .limit(5);
  const row = (data ?? []).find((s: any) => String(s.crm_pipelines?.name ?? "").toLowerCase().includes("prospect")) ?? (data ?? [])[0];
  return row?.id ?? null;
}

async function sourceId(db: SupabaseClient): Promise<string | null> {
  const { data } = await db.from("deal_sources").select("id").eq("name", BOOKING_SOURCE).maybeSingle();
  return data?.id ?? null;
}

export async function createBooking(
  db: SupabaseClient,
  rep: BookableRep,
  req: BookingRequest,
  cfg: BookingConfig
): Promise<{ bookingId: string; dealId: string | null; dealCreated: boolean; contactId: string | null; token: string }> {
  const email = normEmail(req.email);
  const phone = normPhone(req.phone);
  const startIso = new Date(req.startAt).toISOString();
  const endIso = new Date(req.startAt + cfg.slot_minutes * 60_000).toISOString();
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 24);

  // 1) Reserve the slot (unique index rejects a race for the same rep+slot).
  const { data: booking, error: bErr } = await db
    .from("bookings")
    .insert({
      rep_id: rep.id, via: req.via, kind: req.kind, customer_name: req.name, customer_email: email, customer_phone: phone,
      customer_tz: req.tz, note: req.note, start_at: startIso, end_at: endIso, cancel_token: token,
    })
    .select("id")
    .single();
  if (bErr || !booking) throw new Error(bErr?.code === "23505" ? "slot_taken" : bErr?.message ?? "booking failed");

  // 2) Contact: match by email, then phone; else create.
  let contact = await findContact(db, email, phone);
  if (!contact) {
    const [first, ...rest] = req.name.split(/\s+/);
    const { data: created } = await db
      .from("crm_contacts")
      .insert({
        name: req.name, first_name: first || null, last_name: rest.join(" ") || null,
        emails: email ? [{ value: email, primary: true }] : [],
        phones: phone ? [{ value: phone, e164: phone, primary: true }] : [],
        source: BOOKING_SOURCE,
      })
      .select("id, name, dnc")
      .single();
    contact = created;
  }

  // 3) Deal: newest OPEN deal on the contact, else a new one owned by the rep.
  let dealId: string | null = null;
  let dealCreated = false;
  if (contact) {
    const { data: open } = await db
      .from("crm_deals")
      .select("id")
      .eq("contact_id", contact.id)
      .eq("status", "open")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    dealId = open?.id ?? null;
    if (!dealId) {
      const [stageId, srcId] = await Promise.all([defaultStageId(db), sourceId(db)]);
      const { data: deal } = await db
        .from("crm_deals")
        .insert({
          title: `Scheduled Call - ${req.name}`,
          contact_id: contact.id,
          stage_id: stageId,
          status: "open",
          owner_pipedrive_id: rep.pipedriveUserId,
          owner_email: rep.email,
          source_id: srcId,
          stage_changed_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      dealId = deal?.id ?? null;
      dealCreated = !!dealId;
    }
  }

  // 4) ⭐ Priority activity at the slot (a call, or a meeting for a showroom
  // visit) — actor = the rep, so THEIR countdown fires 10 min before and it
  // shows on their calendar.
  const meta = KIND_META[req.kind];
  const when = `${fmtIn(req.startAt, REP_TZ)} PT`;
  const localWhen = req.tz && req.tz !== REP_TZ ? ` · ${fmtIn(req.startAt, req.tz)} ${tzAbbrev(req.startAt, req.tz)} for the customer` : "";
  const { data: act } = await db
    .from("crm_activities")
    .insert({
      deal_id: dealId,
      contact_id: contact?.id ?? null,
      type: meta.activityType,
      subject: meta.activitySubject(req.name),
      body: [
        `${meta.label} booked online via ${req.via === "direct" ? `your link (/book/${rep.slug})` : "the round-robin link (/book)"}.`,
        `When: ${when}${localWhen}`,
        req.kind === "showroom" ? `Where: ${SHOWROOM_ADDRESS}` : null,
        `Phone: ${phone ?? "—"} · Email: ${email ?? "—"}`,
        req.note ? `Customer note: ${req.note}` : null,
      ].filter(Boolean).join("\n"),
      actor: rep.email,
      due_at: startIso,
      occurred_at: new Date().toISOString(),
      meta: { priority: true, booking_id: booking.id, booked_online: true, booking_kind: req.kind, customer_tz: req.tz },
    })
    .select("id")
    .single();

  await db
    .from("bookings")
    .update({ contact_id: contact?.id ?? null, deal_id: dealId, deal_created: dealCreated, activity_id: act?.id ?? null })
    .eq("id", booking.id);

  // 5) Reschedule: the prior booking is cancelled now that the new one exists.
  let rescheduledFrom: number | null = null;
  if (req.rebookToken) {
    const prev = await cancelBooking(db, req.rebookToken, { reason: "rescheduled", rescheduledTo: booking.id, quiet: true });
    if (prev) rescheduledFrom = Date.parse(prev.start_at);
  }

  // 6) Emails — rep alert from cainen@, confirmation from the rep. Never fail
  // the booking on mail.
  try {
    await sendBookingEmails(db, rep, req, { email, phone, dealId, dealCreated, token, rescheduledFrom }, cfg);
  } catch (e) {
    console.error("booking emails failed", e);
  }

  return { bookingId: booking.id, dealId, dealCreated, contactId: contact?.id ?? null, token };
}

// ── Self-service: look up / cancel by token ──────────────────────────────────

export interface ManagedBooking {
  id: string;
  kind: BookingKind;
  status: string;
  start_at: string;
  end_at: string;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  customer_tz: string | null;
  note: string | null;
  rep: BookableRep | null;
  deal_id: string | null;
  activity_id: string | null;
}

export async function getBookingByToken(db: SupabaseClient, token: string): Promise<ManagedBooking | null> {
  if (!/^[a-f0-9]{24}$/.test(token)) return null;
  const { data: b } = await db
    .from("bookings")
    .select("id, kind, status, start_at, end_at, customer_name, customer_email, customer_phone, customer_tz, note, deal_id, activity_id, rep_id")
    .eq("cancel_token", token)
    .maybeSingle();
  if (!b) return null;
  const reps = await bookableReps(db);
  const rep = reps.find((r) => r.id === b.rep_id) ?? null;
  return { ...(b as any), kind: isBookingKind(b.kind) ? b.kind : "call", rep };
}

/**
 * Cancel a booking: status → cancelled, the ⭐ activity is closed out (marked
 * done + relabelled so it stops counting as an upcoming call), a system note
 * lands on the deal, and — unless quiet (a reschedule sends its own
 * confirmation) — the rep is emailed from cainen@ and the customer from the rep.
 */
export async function cancelBooking(
  db: SupabaseClient,
  token: string,
  opts: { reason: "cancelled" | "rescheduled"; rescheduledTo?: string | null; quiet?: boolean }
): Promise<ManagedBooking | null> {
  const b = await getBookingByToken(db, token);
  if (!b || b.status !== "booked") return b;
  const now = new Date().toISOString();
  await db
    .from("bookings")
    .update({ status: "cancelled", cancelled_at: now, cancel_reason: opts.reason, rescheduled_to: opts.rescheduledTo ?? null })
    .eq("id", b.id);
  const when = `${fmtIn(Date.parse(b.start_at), REP_TZ)} PT`;
  const noun = KIND_META[b.kind].noun;
  if (b.activity_id) {
    await db
      .from("crm_activities")
      .update({ done_at: now, subject: `❌ ${opts.reason === "rescheduled" ? "Rescheduled" : "Cancelled"} — ${noun} with ${b.customer_name}` })
      .eq("id", b.activity_id);
  }
  if (b.deal_id) {
    await db.from("crm_activities").insert({
      deal_id: b.deal_id,
      contact_id: null,
      type: "system",
      subject: opts.reason === "rescheduled" ? `📅 Customer rescheduled their ${noun} (was ${when})` : `❌ Customer cancelled their ${noun} (was ${when})`,
      actor: b.rep?.email ?? "system",
      occurred_at: now,
    });
  }
  if (!opts.quiet && b.rep) {
    try {
      const { sendGmail } = await import("./gmail");
      const { data: cainen } = await db.from("gmail_accounts").select("*").eq("user_email", SENDER_EMAIL).eq("status", "active").maybeSingle();
      if (cainen) {
        await sendGmail(db, cainen, {
          to: b.rep.email,
          subject: `❌ ${KIND_META[b.kind].label} cancelled — ${b.customer_name} · ${fmtIn(Date.parse(b.start_at), REP_TZ)} PT`,
          body: [`${b.customer_name} cancelled the ${noun} that was booked for ${when}.`, ``, `Phone: ${b.customer_phone ?? "—"} · Email: ${b.customer_email ?? "—"}`, b.deal_id ? `Deal: ${APP_URL}/crm/deal/${b.deal_id}` : null].filter(Boolean).join("\n"),
        });
      }
      if (b.customer_email) {
        const from = (await repSender(db, b.rep)) ?? cainen;
        if (from) {
          await sendGmail(db, from, {
            to: b.customer_email,
            subject: `Your ${noun} with ${b.rep.first} has been cancelled`,
            body: [`Hi ${b.customer_name.split(/\s+/)[0]},`, ``, `Your ${noun} with me on ${fmtIn(Date.parse(b.start_at), b.customer_tz ?? REP_TZ, { weekday: "long" })} ${tzAbbrev(Date.parse(b.start_at), b.customer_tz ?? REP_TZ)} is cancelled.`, ``, `Want to pick a new time? ${repBookingUrl(b.rep.slug)}`, ``, `${b.rep.name}`, `Lone Peak Overland`].join("\n"),
          });
        }
      }
    } catch (e) {
      console.error("cancel emails failed", e);
    }
  }
  return { ...b, status: "cancelled" };
}

/** The rep's own connected Gmail (customer-facing mail comes from the rep). */
async function repSender(db: SupabaseClient, rep: BookableRep): Promise<any | null> {
  const { data } = await db.from("gmail_accounts").select("*").eq("user_email", rep.email).eq("status", "active").maybeSingle();
  return data ?? null;
}

export function tzAbbrev(utcMs: number, tz: string): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(utcMs));
  return p.find((x) => x.type === "timeZoneName")?.value ?? tz;
}

async function sendBookingEmails(
  db: SupabaseClient,
  rep: BookableRep,
  req: BookingRequest,
  ctx: { email: string | null; phone: string | null; dealId: string | null; dealCreated: boolean; token: string; rescheduledFrom: number | null },
  cfg: BookingConfig
) {
  const { sendGmail } = await import("./gmail");
  const { data: cainen } = await db.from("gmail_accounts").select("*").eq("user_email", SENDER_EMAIL).eq("status", "active").maybeSingle();
  const ptWhen = `${fmtIn(req.startAt, REP_TZ, { weekday: "long" })} PT`;
  const custWhen = `${fmtIn(req.startAt, req.tz, { weekday: "long" })} ${tzAbbrev(req.startAt, req.tz)}`;
  const dealLink = ctx.dealId ? `${APP_URL}/crm/deal/${ctx.dealId}` : null;
  const resched = ctx.rescheduledFrom != null ? `${fmtIn(ctx.rescheduledFrom, REP_TZ)} PT` : null;

  // Rep alert — from cainen@ (Kyle's choice), for direct AND round-robin bookings.
  const km = KIND_META[req.kind];
  if (cainen) {
    await sendGmail(db, cainen, {
      to: rep.email,
      subject: `${km.emoji} ${resched ? `${km.label} rescheduled` : km.alertTitle} — ${req.name} · ${fmtIn(req.startAt, REP_TZ)} PT`,
      body: [
        resched
          ? `${req.name} moved their ${km.noun} with you from ${resched} to a new time.`
          : `${req.name} booked a ${km.noun} with you${req.via === "round_robin" ? " (assigned by round robin)" : ""}.`,
        ``,
        `Type: ${km.label}`,
        `When: ${ptWhen}`,
        req.kind === "showroom" ? `Where: ${SHOWROOM_ADDRESS}` : null,
        req.tz !== REP_TZ ? `Customer's local time: ${custWhen}` : null,
        `Phone: ${ctx.phone ?? "—"}`,
        `Email: ${ctx.email ?? "—"}`,
        req.note ? `Note: ${req.note}` : null,
        ``,
        ctx.dealId ? `Deal: ${dealLink}${ctx.dealCreated ? " (new deal created and assigned to you)" : " (existing deal)"}` : `No deal could be linked.`,
        ``,
        `A ⭐ priority reminder is set — the countdown will start 10 minutes before the call.`,
      ].filter((l) => l != null).join("\n"),
    });
  }

  // Customer confirmation — from the rep they booked with (their connected
  // Gmail, cainen@ fallback), in the rep's own words: their template, else the
  // team default, else the built-in. The reschedule/cancel link is always
  // appended and is not part of the editable text.
  if (ctx.email) {
    const from = (await repSender(db, rep)) ?? cainen;
    if (!from) return;
    const tpl = confirmationTemplate(cfg, rep, req.kind);
    const vars: Record<string, string> = {
      first_name: req.name.split(/\s+/)[0],
      name: req.name,
      address: SHOWROOM_ADDRESS,
      when: custWhen,
      date: new Intl.DateTimeFormat("en-US", { timeZone: req.tz, weekday: "long", month: "long", day: "numeric" }).format(new Date(req.startAt)),
      time: `${new Intl.DateTimeFormat("en-US", { timeZone: req.tz, hour: "numeric", minute: "2-digit" }).format(new Date(req.startAt))} ${tzAbbrev(req.startAt, req.tz)}`,
      phone: ctx.phone ?? "the number you provided",
      rep_first: rep.first,
      rep_name: rep.name,
    };
    const subject = renderTemplate(tpl.subject, vars);
    const body = renderTemplate(tpl.body, vars);
    await sendGmail(db, from, {
      to: ctx.email,
      subject: resched ? `Updated: ${subject}` : subject,
      body: [
        resched ? `(Your ${km.noun} has been moved — here are the new details.)\n` : null,
        body,
        ``,
        `Need to reschedule or cancel? ${manageBookingUrl(ctx.token)}`,
      ].filter((l) => l != null).join("\n"),
    });
  }
}
