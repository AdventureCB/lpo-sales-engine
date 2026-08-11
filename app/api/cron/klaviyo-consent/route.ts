import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { pageProfilesSmsConsent } from "@/lib/klaviyo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const STATE_KEY = "klaviyo_sms_consent_sync";
const PAGES_PER_RUN = 30; // 3k profiles/run, well inside Klaviyo's profile rate limit
const REFRESH_DAYS = 7;

/**
 * Klaviyo → SMS consent backfill (auto-apply, per Kyle: no approval step).
 * Pages the full profile base; a Klaviyo SMS marketing SUBSCRIBED lands as
 * opted_in on the matching contact — but ONLY where we have no consent
 * recorded yet: explicit survey answers and STOPs always outrank an
 * inferred Klaviyo subscription. Unsubscribed/never-subscribed are ignored
 * (absence of Klaviyo marketing consent says nothing about 1:1 texting).
 * Full pass ≈ 8 runs, then re-sweeps weekly for new subscriptions.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();

  const { data: stateRow } = await db.from("crm_sync_state").select("value").eq("key", STATE_KEY).maybeSingle();
  const state = (stateRow?.value ?? {}) as {
    next_url?: string | null;
    completed_at?: string | null;
    next_full_at?: string | null;
    applied_total?: number;
  };
  if (!state.next_url && state.next_full_at && new Date().toISOString() < state.next_full_at) {
    return NextResponse.json({ skipped: "pass complete", nextFullAt: state.next_full_at });
  }

  // Contact lookup map: every email → contact id + current consent.
  const byEmail = new Map<string, { id: string; consent: string | null }>();
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("crm_contacts")
        .select("id, emails, sms_consent")
        .range(from, from + PAGE - 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      for (const c of data ?? []) {
        for (const e of (c.emails as any[]) ?? []) {
          const k = (e?.value ?? "").toLowerCase().trim();
          if (k && !byEmail.has(k)) byEmail.set(k, { id: c.id, consent: c.sms_consent });
        }
      }
      if ((data ?? []).length < PAGE) break;
    }
  }

  let cursor = state.next_url ?? null;
  let scanned = 0;
  let applied = 0;
  let pages = 0;
  let done = false;

  while (pages < PAGES_PER_RUN) {
    const page = await pageProfilesSmsConsent(cursor);
    pages++;
    for (const p of page.profiles) {
      scanned++;
      if (p.smsConsent !== "SUBSCRIBED" || !p.email) continue;
      const c = byEmail.get(p.email);
      if (!c || c.consent != null) continue; // explicit statements outrank Klaviyo
      const { error } = await db
        .from("crm_contacts")
        .update({
          sms_consent: "opted_in",
          sms_consent_at: p.consentAt ?? new Date().toISOString(),
          sms_consent_source: "Klaviyo",
          updated_at: new Date().toISOString(),
        })
        .eq("id", c.id)
        .is("sms_consent", null);
      if (!error) {
        applied++;
        c.consent = "opted_in";
      }
    }
    cursor = page.next;
    if (!cursor) {
      done = true;
      break;
    }
  }

  const value = done
    ? {
        next_url: null,
        completed_at: new Date().toISOString(),
        next_full_at: new Date(Date.now() + REFRESH_DAYS * 86_400_000).toISOString(),
        applied_total: (state.applied_total ?? 0) + applied,
      }
    : { ...state, next_url: cursor, applied_total: (state.applied_total ?? 0) + applied };
  await db
    .from("crm_sync_state")
    .upsert({ key: STATE_KEY, value, updated_at: new Date().toISOString() }, { onConflict: "key" });

  return NextResponse.json({ scanned, applied, passComplete: done });
}
