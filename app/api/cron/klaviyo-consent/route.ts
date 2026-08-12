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
 * Pages the full profile base and hands each run's SUBSCRIBED emails to
 * apply_klaviyo_consent (Postgres does the indexed, case-insensitive match
 * and update) — so the Node function does no contact scanning, only the
 * Klaviyo I/O. A Klaviyo SMS-marketing SUBSCRIBED lands as opted_in ONLY
 * where no consent is recorded yet: explicit survey answers and STOPs
 * outrank. Unsubscribed/never-subscribed are ignored. Full pass ≈ 8 runs,
 * then re-sweeps weekly for new subscriptions.
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

  let cursor = state.next_url ?? null;
  let scanned = 0;
  let pages = 0;
  let done = false;
  const emails: string[] = [];
  const ats: (string | null)[] = [];

  while (pages < PAGES_PER_RUN) {
    const page = await pageProfilesSmsConsent(cursor);
    pages++;
    for (const p of page.profiles) {
      scanned++;
      if (p.smsConsent === "SUBSCRIBED" && p.email) {
        emails.push(p.email);
        ats.push(p.consentAt ?? null);
      }
    }
    cursor = page.next;
    if (!cursor) {
      done = true;
      break;
    }
  }

  // One indexed statement matches this run's subscribed emails to contacts
  // and fills only the blanks. No contact scanning in Node.
  let applied = 0;
  if (emails.length) {
    const { data, error } = await db.rpc("apply_klaviyo_consent", { p_emails: emails, p_ats: ats });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    applied = (data as number) ?? 0;
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

  return NextResponse.json({ scanned, subscribed: emails.length, applied, passComplete: done });
}
