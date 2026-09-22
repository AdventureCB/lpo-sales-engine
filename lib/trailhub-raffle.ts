import "server-only";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findContact, normEmail, normPhone, processIntake, type IntakeSource } from "./intake";

/**
 * Trailhub raffle intake — the community app's drawing entrants as leads.
 *
 * Trailhub is a SEPARATE Supabase project (babbgaziiyjfaqjsaxgd) in our org.
 * Contract (Trailhub side, 9/22): ONE read-only view `public.crm_raffle_leads`
 * read over a direct Postgres connection as the scoped role `crm_reader`
 * (sees that view and nothing else — no service-role key of theirs is held
 * here). TRAILHUB_DB_URL (Vercel, sensitive) = pooler connection string.
 * The view is not on the REST API, so this uses node-postgres, not supabase-js.
 *
 * Twice-daily poll (pg_cron → /api/cron/trailhub-raffle) on the view's
 * `updated_at` = greatest(entered_at, contact_opt_in_at, won_at):
 *   - new entry / consent flip → processIntake (engine pool / source / stage /
 *     existing-deal rules; idempotent per entry_id, so a repeat entrant across
 *     drawings becomes a note on their deal)
 *   - winner flip → ONE ⭐ priority task on the deal with the prize code
 * Consent rule: contact_opt_in=false rows are legacy — only a WINNER among
 * them comes through, flagged prize-only.
 */

const TRAILHUB_PUBLIC = "https://trailhead.lonepeakoverland.com";

interface Lead {
  entry_id: string; user_id: string; event_id: string;
  name: string | null; email: string | null; phone: string | null;
  contact_opt_in: boolean | null; contact_opt_in_at: Date | null; is_winner: boolean | null; won_at: Date | null;
  entered_at: Date; updated_at: Date;
  event_name: string; event_slug: string; event_status: string; event_discount_cents: number | null; event_min_purchase_cents: number | null;
  handle: string | null; full_name: string | null; avatar_url: string | null;
  winner_code: string | null; winner_code_expires_at: Date | null;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const usd = (cents: number | null | undefined) => (cents == null ? "" : `$${Math.round(cents / 100).toLocaleString()}`);
const fmtDate = (d: Date | string | null | undefined) =>
  d ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" }).format(new Date(d)) : "";

/** Rows changed since the watermark, oldest first. Opens/closes one connection (twice a day — no pool needed). */
export async function fetchTrailhubLeads(since: string, limit = 500): Promise<Lead[]> {
  const url = process.env.TRAILHUB_DB_URL;
  if (!url) throw new Error("TRAILHUB_DB_URL not configured");
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 20_000, application_name: "lpo-sales-engine" });
  await client.connect();
  try {
    const { rows } = await client.query<Lead>(
      "select * from public.crm_raffle_leads where updated_at > $1 order by updated_at, entry_id limit $2",
      [since, limit]
    );
    return rows;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function runTrailhubRaffle(db: SupabaseClient, source: IntakeSource, opts: { dry?: boolean } = {}) {
  const cursorKey = `intake:trailhub_raffle:${source.id}`;
  const { data: cur } = await db.from("crm_sync_state").select("value").eq("key", cursorKey).maybeSingle();
  const since: string = (cur?.value as any)?.since ?? "1970-01-01T00:00:00Z";

  let rows: Lead[];
  try {
    rows = await fetchTrailhubLeads(since);
  } catch (e) {
    return { error: `trailhub read failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const tally: Record<string, number> = {};
  const bump = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);
  let watermark = since;
  const advance = (d: Date | string | null | undefined) => { const s = iso(d); if (s && s > watermark) watermark = s; };
  const preview: unknown[] = [];

  const identity = (r: Lead) => {
    const email = normEmail(r.email);
    const phone = normPhone(r.phone);
    const name = r.name?.trim() || r.full_name?.trim() || (email ? email.split("@")[0] : "Trailhub entrant");
    return { email, phone, name };
  };

  const ingest = async (r: Lead) => {
    const consent = r.contact_opt_in === true;
    if (!consent && !r.is_winner) return { action: "skipped" as const, dealId: null, detail: "no consent" };
    const { email, phone, name } = identity(r);
    const note = [
      `Entered the "${r.event_name}" drawing on ${fmtDate(r.entered_at)}${r.handle ? ` as @${r.handle}` : ""}.`,
      `Prize: ${usd(r.event_discount_cents)} off${r.event_min_purchase_cents ? ` (min. purchase ${usd(r.event_min_purchase_cents)})` : ""}.`,
      consent ? `✅ Consented to sales contact (call / text / email) on ${fmtDate(r.contact_opt_in_at)}.` : `⚠️ No sales-contact consent — contact only about the prize.`,
    ].join("\n");
    if (opts.dry) {
      preview.push({ name, event: r.event_name, consent, winner: !!r.is_winner, has_email: !!email, has_phone: !!phone });
      return { action: "dry" as const, dealId: null };
    }
    return processIntake(db, source, {
      externalId: r.entry_id,
      email,
      phone,
      name,
      link: `${TRAILHUB_PUBLIC}/win/${r.event_slug}`,
      note,
      occurredAt: iso(r.entered_at),
      meta: { trailhub_user_id: r.user_id, event: r.event_name, event_slug: r.event_slug, consent, handle: r.handle, is_winner: !!r.is_winner },
    });
  };

  for (const r of rows) {
    // A) New entry, or a legacy row that just gained consent — processIntake
    //    dedupes on entry_id, so re-running over an ingested row is a no-op.
    const enteredAt = iso(r.entered_at)!;
    const consentAt = iso(r.contact_opt_in_at);
    if (enteredAt > since || (consentAt && consentAt > since)) {
      const res = await ingest(r);
      bump(res.action);
    }

    // B) Winner flip → one ⭐ task (idempotent via intake_events "win:<entry>").
    const wonAt = iso(r.won_at);
    if (r.is_winner && wonAt && wonAt > since) {
      const winKey = `win:${r.entry_id}`;
      const { data: seen } = await db.from("intake_events").select("id").eq("source_id", source.id).eq("external_id", winKey).limit(1).maybeSingle();
      if (seen) { advance(r.updated_at); continue; }
      if (opts.dry) { bump("dry_win"); advance(r.updated_at); continue; }

      // The deal this entrant lives on: the one their entry created/noted, else
      // their newest deal; a never-ingested legacy winner was ingested in A).
      const { email, phone, name } = identity(r);
      const { data: ie } = await db.from("intake_events").select("deal_id").eq("source_id", source.id).eq("external_id", r.entry_id).not("deal_id", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
      let dealId: string | null = ie?.deal_id ?? null;
      const contact = await findContact(db, email, phone);
      if (!dealId && contact) {
        const { data: d } = await db.from("crm_deals").select("id").eq("contact_id", contact.id).order("updated_at", { ascending: false }).limit(1).maybeSingle();
        dealId = d?.id ?? null;
      }
      const { data: deal } = dealId ? await db.from("crm_deals").select("owner_email").eq("id", dealId).maybeSingle() : { data: null };
      const now = new Date().toISOString();
      await db.from("crm_activities").insert({
        deal_id: dealId,
        contact_id: contact?.id ?? null,
        type: "task",
        subject: `🏆 Won the "${r.event_name}" drawing — ${usd(r.event_discount_cents)} off`,
        body: [
          `${name}${r.handle ? ` (@${r.handle})` : ""} was drawn as the winner on ${fmtDate(r.won_at)}.`,
          r.winner_code ? `Discount code: ${r.winner_code}` : "Discount code: (not issued yet)",
          r.winner_code_expires_at ? `Expires: ${fmtDate(r.winner_code_expires_at)}` : null,
          r.event_min_purchase_cents ? `Minimum purchase: ${usd(r.event_min_purchase_cents)}` : null,
          r.contact_opt_in ? null : `⚠️ No sales-contact consent — contact only about the prize.`,
          `${TRAILHUB_PUBLIC}/win/${r.event_slug}`,
        ].filter(Boolean).join("\n"),
        actor: deal?.owner_email ?? "intake",
        due_at: now,
        occurred_at: now,
        meta: { priority: true, trailhub_entry_id: r.entry_id, trailhub_win: true },
      });
      await db.from("intake_events").insert({
        source_id: source.id, external_id: winKey, email, phone, action: "noted", deal_id: dealId,
        detail: { win: true, event: r.event_name, code: r.winner_code, expires_at: iso(r.winner_code_expires_at) },
      });
      bump("winner");
    }
    advance(r.updated_at);
  }

  if (!opts.dry && watermark !== since) {
    await db.from("crm_sync_state").upsert({ key: cursorKey, value: { since: watermark }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }
  return { ok: true, dry: !!opts.dry, since, watermark, rows: rows.length, ...tally, ...(opts.dry ? { preview: preview.slice(0, 20) } : {}) };
}
