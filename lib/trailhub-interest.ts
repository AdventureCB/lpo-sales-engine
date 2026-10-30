import "server-only";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normEmail, normPhone, processIntake, type IntakeSource } from "./intake";

/**
 * Trailhub product-interest intake — people who signed up to hear about an
 * upcoming product (the new camper is the first list) in the community app.
 *
 * Same model as the raffle (lib/trailhub-raffle.ts): nothing is pushed; we
 * PULL from ONE read-only view `public.crm_interest_leads` in the Trailhub
 * Supabase project over a direct Postgres connection as the scoped role
 * `crm_reader` (TRAILHUB_DB_URL, Vercel-sensitive). Not on their REST API.
 *
 * Contract (Trailhub side, 10/30): one row per person per interest list;
 * `signup_id` is the stable dedupe key; `updated_at` is the incremental
 * watermark (greatest of signup / consent time); `contact_opt_in` is always
 * true (consent is a condition of signing up) but kept in the model so the
 * raffle and interest rows share one shape; `source` = which placement sent
 * them (?src= on the link), `utm` = any utm_* params (lowercased keys).
 *
 * Hourly poll (pg_cron → /api/cron/trailhub-interest): each new signup →
 * processIntake (engine pool / source / stage / existing-deal rules; idempotent
 * per signup_id, so a second list signup by the same person is a note on
 * their deal, not a second deal).
 */

const TRAILHUB_PUBLIC = "https://trailhead.lonepeakoverland.com";

interface Lead {
  signup_id: string; user_id: string;
  list_id: string; list_slug: string; list_name: string; list_status: string;
  name: string | null; email: string | null; phone: string | null;
  contact_opt_in: boolean | null; contact_opt_in_at: Date | null;
  source: string | null; utm: Record<string, string> | null;
  signed_up_at: Date; updated_at: Date;
  handle: string | null; full_name: string | null; avatar_url: string | null;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const fmtDate = (d: Date | string | null | undefined) =>
  d ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" }).format(new Date(d)) : "";

/** Rows changed since the watermark, oldest first. One connection per poll (hourly — no pool needed). */
export async function fetchTrailhubInterest(since: string, limit = 500): Promise<Lead[]> {
  const url = process.env.TRAILHUB_DB_URL;
  if (!url) throw new Error("TRAILHUB_DB_URL not configured");
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 20_000, application_name: "lpo-sales-engine" });
  await client.connect();
  try {
    const { rows } = await client.query<Lead>(
      "select * from public.crm_interest_leads where updated_at > $1 order by updated_at, signup_id limit $2",
      [since, limit]
    );
    return rows;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function runTrailhubInterest(db: SupabaseClient, source: IntakeSource, opts: { dry?: boolean } = {}) {
  const cursorKey = `intake:trailhub_interest:${source.id}`;
  const { data: cur } = await db.from("crm_sync_state").select("value").eq("key", cursorKey).maybeSingle();
  const since: string = (cur?.value as any)?.since ?? "1970-01-01T00:00:00Z";

  let rows: Lead[];
  try {
    rows = await fetchTrailhubInterest(since);
  } catch (e) {
    return { error: `trailhub read failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const tally: Record<string, number> = {};
  const bump = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);
  let watermark = since;
  const advance = (d: Date | string | null | undefined) => { const s = iso(d); if (s && s > watermark) watermark = s; };
  const preview: unknown[] = [];

  for (const r of rows) {
    const email = normEmail(r.email);
    const phone = normPhone(r.phone);
    const name = r.name?.trim() || r.full_name?.trim() || (email ? email.split("@")[0] : "Trailhub member");
    let res: { action: string; detail?: unknown };
    if (/\btest\b/i.test(r.list_name ?? "")) res = { action: "skipped", detail: "test list" };
    else if (email && /@lonepeakoverland\.com$/i.test(email)) res = { action: "skipped", detail: "internal signup" };
    else if (r.contact_opt_in !== true) res = { action: "skipped", detail: "no consent" }; // never expected — consent is required to sign up
    else {
      const utm = r.utm && Object.keys(r.utm).length ? Object.entries(r.utm).map(([k, v]) => `${k.replace(/^utm_/, "")}=${v}`).join(" · ") : null;
      const note = [
        `Signed up for "${r.list_name}" product updates on ${fmtDate(r.signed_up_at)}${r.handle ? ` as @${r.handle}` : ""}.`,
        `Came from: ${r.source ?? "app link (no placement tag)"}${utm ? ` · ${utm}` : ""}.`,
        `✅ Consented to sales contact (call / text / email) on ${fmtDate(r.contact_opt_in_at ?? r.signed_up_at)}.`,
      ].join("\n");
      if (opts.dry) {
        preview.push({ name, list: r.list_name, source: r.source, utm: r.utm, has_email: !!email, has_phone: !!phone });
        res = { action: "dry" };
      } else {
        res = await processIntake(db, source, {
          externalId: r.signup_id,
          email,
          phone,
          name,
          link: `${TRAILHUB_PUBLIC}/interest/${r.list_slug}`,
          note,
          occurredAt: iso(r.signed_up_at),
          meta: {
            trailhub_user_id: r.user_id, list: r.list_name, list_slug: r.list_slug, list_status: r.list_status,
            consent: true, handle: r.handle, placement: r.source, utm: r.utm ?? null, lead_type: `Product interest — ${r.list_name}`,
          },
        });
      }
    }
    bump(res.action);
    advance(r.updated_at);
  }

  if (!opts.dry && watermark !== since) {
    await db.from("crm_sync_state").upsert({ key: cursorKey, value: { since: watermark }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }
  return { ok: true, dry: !!opts.dry, since, watermark, rows: rows.length, ...tally, ...(opts.dry ? { preview: preview.slice(0, 20) } : {}) };
}
