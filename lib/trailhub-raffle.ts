import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { findContact, normEmail, normPhone, processIntake, type IntakeSource } from "./intake";

/**
 * Trailhub raffle intake — the community app's drawing entrants as leads.
 *
 * Trailhub is a SEPARATE Supabase project (babbgaziiyjfaqjsaxgd) that shares
 * our org, so this is a cross-project READ via its service-role key
 * (TRAILHUB_SUPABASE_URL / TRAILHUB_SERVICE_KEY, Vercel-only). We never write
 * to Trailhub; CRM state lives here (intake_events keyed by raffle_entries.id).
 *
 * Twice-daily poll (pg_cron → /api/cron/trailhub-raffle) on a watermark of
 * greatest(created_at, won_at):
 *   - new entries → processIntake (engine pool / source / stage / existing-deal
 *     rules; a repeat entrant across drawings becomes a note on their deal)
 *   - winner flips → one ⭐ priority task on the deal with the prize code
 * Consent rule (Trailhub spec): contact_opt_in=false rows are legacy — only a
 * WINNER among them comes through, flagged prize-only.
 */

const TRAILHUB_PUBLIC = "https://trailhead.lonepeakoverland.com";
// No PostgREST embed: raffle_events ↔ raffle_entries has two FKs (event_id and
// winner_entry_id), which makes the embed ambiguous — events are fetched by id.
const ENTRY_COLS = "id, event_id, user_id, name, email, phone, contact_opt_in, contact_opt_in_at, is_winner, won_at, created_at";

interface RaffleEvent { id: string; name: string; slug: string; status: string; discount_cents: number | null; min_purchase_cents: number | null }
interface Entry {
  id: string; event_id: string; user_id: string; name: string | null; email: string | null; phone: string | null;
  contact_opt_in: boolean | null; contact_opt_in_at: string | null; is_winner: boolean | null; won_at: string | null; created_at: string;
}
interface Profile { id: string; handle: string | null; full_name: string | null; phone: string | null }
interface WinnerCode { entry_id: string; code: string | null; discount_cents: number | null; min_purchase_cents: number | null; expires_at: string | null }

export function trailhubClient(): SupabaseClient | null {
  const url = process.env.TRAILHUB_SUPABASE_URL;
  const key = process.env.TRAILHUB_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const usd = (cents: number | null | undefined) => (cents == null ? "" : `$${Math.round(cents / 100).toLocaleString()}`);
const fmtDate = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" }).format(new Date(iso)) : "";

export async function runTrailhubRaffle(db: SupabaseClient, source: IntakeSource, opts: { dry?: boolean } = {}) {
  const th = trailhubClient();
  if (!th) return { error: "TRAILHUB_SUPABASE_URL / TRAILHUB_SERVICE_KEY not configured" };

  const cursorKey = `intake:trailhub_raffle:${source.id}`;
  const { data: cur } = await db.from("crm_sync_state").select("value").eq("key", cursorKey).maybeSingle();
  const since: string = (cur?.value as any)?.since ?? "1970-01-01T00:00:00Z";

  const [{ data: fresh, error: e1 }, { data: wins, error: e2 }] = await Promise.all([
    th.from("raffle_entries").select(ENTRY_COLS).gt("created_at", since).order("created_at").limit(500),
    th.from("raffle_entries").select(ENTRY_COLS).eq("is_winner", true).gt("won_at", since).order("won_at").limit(100),
  ]);
  if (e1 || e2) return { error: `trailhub read failed: ${(e1 ?? e2)?.message}` };
  const entries = (fresh ?? []) as unknown as Entry[];
  const winners = (wins ?? []) as unknown as Entry[];

  // Events, profiles (handle / fallback name+phone) and prize codes — one round-trip each.
  const eventIds = [...new Set([...entries, ...winners].map((e) => e.event_id))];
  const userIds = [...new Set([...entries, ...winners].map((e) => e.user_id))];
  const [{ data: evs }, { data: profs }, { data: codes }] = await Promise.all([
    eventIds.length ? th.from("raffle_events").select("id, name, slug, status, discount_cents, min_purchase_cents").in("id", eventIds) : Promise.resolve({ data: [] as RaffleEvent[] }),
    userIds.length ? th.from("profiles").select("id, handle, full_name, phone").in("id", userIds) : Promise.resolve({ data: [] as Profile[] }),
    winners.length ? th.from("raffle_winner_codes").select("entry_id, code, discount_cents, min_purchase_cents, expires_at").in("entry_id", winners.map((w) => w.id)) : Promise.resolve({ data: [] as WinnerCode[] }),
  ]);
  const events = new Map(((evs ?? []) as RaffleEvent[]).map((x) => [x.id, x]));
  const ev = (e: Entry): RaffleEvent | null => events.get(e.event_id) ?? null;
  const profile = new Map(((profs ?? []) as Profile[]).map((p) => [p.id, p]));
  const codeFor = new Map(((codes ?? []) as WinnerCode[]).map((c) => [c.entry_id, c]));

  const tally: Record<string, number> = {};
  const bump = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);
  let watermark = since;
  const advance = (iso: string | null | undefined) => { if (iso && iso > watermark) watermark = iso; };

  const identity = (e: Entry) => {
    const p = profile.get(e.user_id);
    const email = normEmail(e.email);
    const phone = normPhone(e.phone) ?? normPhone(p?.phone);
    const name = e.name?.trim() || p?.full_name?.trim() || (email ? email.split("@")[0] : "Trailhub entrant");
    return { email, phone, name, handle: p?.handle ?? null };
  };

  const ingest = async (e: Entry) => {
    const event = ev(e);
    if (!event || event.status === "draft") return { action: "skipped" as const, dealId: null, detail: "draft event" };
    const consent = e.contact_opt_in === true;
    if (!consent && !e.is_winner) return { action: "skipped" as const, dealId: null, detail: "no consent" };
    const { email, phone, name, handle } = identity(e);
    const note = [
      `Entered the "${event.name}" drawing on ${fmtDate(e.created_at)}${handle ? ` as @${handle}` : ""}.`,
      `Prize: ${usd(event.discount_cents)} off${event.min_purchase_cents ? ` (min. purchase ${usd(event.min_purchase_cents)})` : ""}.`,
      consent ? `✅ Consented to sales contact (call / text / email) on ${fmtDate(e.contact_opt_in_at)}.` : `⚠️ No sales-contact consent — contact only about the prize.`,
    ].join("\n");
    if (opts.dry) return { action: "dry" as const, dealId: null, detail: `${name} · ${email ?? "—"} · ${phone ?? "—"} · ${event.name}` };
    return processIntake(db, source, {
      externalId: e.id,
      email,
      phone,
      name,
      link: `${TRAILHUB_PUBLIC}/win/${event.slug}`,
      note,
      occurredAt: e.created_at,
      meta: { trailhub_user_id: e.user_id, event: event.name, event_slug: event.slug, consent, handle, is_winner: !!e.is_winner },
    });
  };

  // ── New entries ──
  for (const e of entries) {
    const r = await ingest(e);
    bump(r.action);
    advance(e.created_at);
  }

  // ── Winner flips → one ⭐ task on the deal (idempotent via intake_events "win:<entry>") ──
  for (const w of winners) {
    const event = ev(w);
    if (!event) continue;
    const winKey = `win:${w.id}`;
    const { data: seen } = await db.from("intake_events").select("id").eq("source_id", source.id).eq("external_id", winKey).limit(1).maybeSingle();
    if (seen) { advance(w.won_at); continue; }
    if (opts.dry) { bump("dry_win"); continue; }

    // The deal this entrant lives on: the row their entry created/noted, else
    // their newest deal; a never-ingested legacy winner is ingested now.
    const { email, phone, name, handle } = identity(w);
    let dealId: string | null = null;
    const { data: ie } = await db.from("intake_events").select("deal_id").eq("source_id", source.id).eq("external_id", w.id).not("deal_id", "is", null).limit(1).maybeSingle();
    dealId = ie?.deal_id ?? null;
    if (!dealId) {
      const r = await ingest(w);
      dealId = r.dealId ?? null;
    }
    const contact = await findContact(db, email, phone);
    if (!dealId && contact) {
      const { data: d } = await db.from("crm_deals").select("id").eq("contact_id", contact.id).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      dealId = d?.id ?? null;
    }
    const code = codeFor.get(w.id);
    const { data: deal } = dealId ? await db.from("crm_deals").select("owner_email").eq("id", dealId).maybeSingle() : { data: null };
    const now = new Date().toISOString();
    await db.from("crm_activities").insert({
      deal_id: dealId,
      contact_id: contact?.id ?? null,
      type: "task",
      subject: `🏆 Won the "${event.name}" drawing — ${usd(code?.discount_cents ?? event.discount_cents)} off`,
      body: [
        `${name}${handle ? ` (@${handle})` : ""} was drawn as the winner on ${fmtDate(w.won_at)}.`,
        code?.code ? `Discount code: ${code.code}` : "Discount code: (not issued yet)",
        code?.expires_at ? `Expires: ${fmtDate(code.expires_at)}` : null,
        code?.min_purchase_cents || event.min_purchase_cents ? `Minimum purchase: ${usd(code?.min_purchase_cents ?? event.min_purchase_cents)}` : null,
        w.contact_opt_in ? null : `⚠️ No sales-contact consent — contact only about the prize.`,
        `${TRAILHUB_PUBLIC}/win/${event.slug}`,
      ].filter(Boolean).join("\n"),
      actor: deal?.owner_email ?? "intake",
      due_at: now,
      occurred_at: now,
      meta: { priority: true, trailhub_entry_id: w.id, trailhub_win: true },
    });
    await db.from("intake_events").insert({
      source_id: source.id, external_id: winKey, email, phone, action: "noted", deal_id: dealId,
      detail: { win: true, event: event.name, code: code?.code ?? null, expires_at: code?.expires_at ?? null },
    });
    bump("winner");
    advance(w.won_at);
  }

  if (!opts.dry && watermark !== since) {
    await db.from("crm_sync_state").upsert({ key: cursorKey, value: { since: watermark }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }
  return { ok: true, dry: !!opts.dry, since, watermark, new_entries: entries.length, winner_flips: winners.length, ...tally };
}
