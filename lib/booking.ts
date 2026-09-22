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

export interface BookingConfig {
  slot_minutes: number;
  days: number[]; // 0=Sun … 6=Sat, in PT
  start: string; // "HH:MM" PT
  end: string; // "HH:MM" PT
  min_notice_hours: number;
  horizon_days: number;
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

export interface BookableRep {
  id: string;
  name: string;
  first: string;
  email: string;
  slug: string;
  pipedriveUserId: number | null;
}

export async function bookableReps(db: SupabaseClient): Promise<BookableRep[]> {
  const { data } = await db
    .from("reps")
    .select("id, name, email, booking_slug, pipedrive_user_id, sort_order")
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
  }));
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

/** Every candidate slot start (UTC ms) inside the config window from now. */
export function candidateSlots(cfg: BookingConfig, now = Date.now()): number[] {
  const out: number[] = [];
  const earliest = now + cfg.min_notice_hours * 3600_000;
  const startDay = dateIn(now, REP_TZ);
  for (let i = 0; i <= cfg.horizon_days; i++) {
    const dayMs = Date.parse(`${startDay}T12:00:00Z`) + i * 86_400_000;
    const date = new Date(dayMs).toISOString().slice(0, 10);
    const dow = new Date(dayMs).getUTCDay();
    if (!cfg.days.includes(dow)) continue;
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
  const cands = candidateSlots(cfg);
  const slotMs = cfg.slot_minutes * 60_000;
  const reps = target.rep ? [target.rep] : target.reps ?? [];
  if (reps.length === 0) return [];
  const busyByRep = await Promise.all(reps.map((r) => busySlots(db, r, cands, slotMs)));
  return cands.filter((s) => busyByRep.some((busy) => !busy.has(s)));
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
): Promise<{ bookingId: string; dealId: string | null; dealCreated: boolean; contactId: string | null }> {
  const email = normEmail(req.email);
  const phone = normPhone(req.phone);
  const startIso = new Date(req.startAt).toISOString();
  const endIso = new Date(req.startAt + cfg.slot_minutes * 60_000).toISOString();

  // 1) Reserve the slot (unique index rejects a race for the same rep+slot).
  const { data: booking, error: bErr } = await db
    .from("bookings")
    .insert({
      rep_id: rep.id, via: req.via, customer_name: req.name, customer_email: email, customer_phone: phone,
      customer_tz: req.tz, note: req.note, start_at: startIso, end_at: endIso,
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

  // 4) ⭐ Priority call activity at the slot — actor = the rep, so THEIR
  // countdown fires 10 min before and it shows on their calendar.
  const when = `${fmtIn(req.startAt, REP_TZ)} PT`;
  const localWhen = req.tz && req.tz !== REP_TZ ? ` · ${fmtIn(req.startAt, req.tz)} ${tzAbbrev(req.startAt, req.tz)} for the customer` : "";
  const { data: act } = await db
    .from("crm_activities")
    .insert({
      deal_id: dealId,
      contact_id: contact?.id ?? null,
      type: "call",
      subject: `📅 Scheduled call — ${req.name}`,
      body: [
        `Booked online via ${req.via === "direct" ? `your link (/book/${rep.slug})` : "the round-robin link (/book)"}.`,
        `When: ${when}${localWhen}`,
        `Phone: ${phone ?? "—"} · Email: ${email ?? "—"}`,
        req.note ? `Customer note: ${req.note}` : null,
      ].filter(Boolean).join("\n"),
      actor: rep.email,
      due_at: startIso,
      occurred_at: new Date().toISOString(),
      meta: { priority: true, booking_id: booking.id, booked_online: true, customer_tz: req.tz },
    })
    .select("id")
    .single();

  await db
    .from("bookings")
    .update({ contact_id: contact?.id ?? null, deal_id: dealId, deal_created: dealCreated, activity_id: act?.id ?? null })
    .eq("id", booking.id);

  // 5) Emails from cainen@ — rep + customer. Never fail the booking on mail.
  try {
    await sendBookingEmails(db, rep, req, { email, phone, dealId, dealCreated });
  } catch (e) {
    console.error("booking emails failed", e);
  }

  return { bookingId: booking.id, dealId, dealCreated, contactId: contact?.id ?? null };
}

export function tzAbbrev(utcMs: number, tz: string): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(utcMs));
  return p.find((x) => x.type === "timeZoneName")?.value ?? tz;
}

async function sendBookingEmails(
  db: SupabaseClient,
  rep: BookableRep,
  req: BookingRequest,
  ctx: { email: string | null; phone: string | null; dealId: string | null; dealCreated: boolean }
) {
  const { data: account } = await db.from("gmail_accounts").select("*").eq("user_email", SENDER_EMAIL).eq("status", "active").maybeSingle();
  if (!account) return;
  const { sendGmail } = await import("./gmail");
  const ptWhen = `${fmtIn(req.startAt, REP_TZ, { weekday: "long" })} PT`;
  const custWhen = `${fmtIn(req.startAt, req.tz, { weekday: "long" })} ${tzAbbrev(req.startAt, req.tz)}`;
  const dealLink = ctx.dealId ? `${APP_URL}/crm/deal/${ctx.dealId}` : null;

  // Rep notification.
  await sendGmail(db, account, {
    to: rep.email,
    subject: `📅 New call booked — ${req.name} · ${fmtIn(req.startAt, REP_TZ)} PT`,
    body: [
      `${req.name} booked a call with you${req.via === "round_robin" ? " (assigned by round robin)" : ""}.`,
      ``,
      `When: ${ptWhen}`,
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

  // Customer confirmation.
  if (ctx.email) {
    const custFirst = req.name.split(/\s+/)[0];
    await sendGmail(db, account, {
      to: ctx.email,
      subject: `Your call with ${rep.first} at Lone Peak Overland is confirmed`,
      body: [
        `Hi ${custFirst},`,
        ``,
        `You're booked with ${rep.first}, one of our Gravel Guides, on ${custWhen}.`,
        `${rep.first} will call you at ${ctx.phone ?? "the number you provided"}.`,
        ``,
        `Need to change the time? Just reply to this email and we'll sort it out.`,
        ``,
        `Talk soon,`,
        `Lone Peak Overland`,
      ].join("\n"),
    });
  }
}
