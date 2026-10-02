import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { pageProfilesEmail } from "@/lib/klaviyo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STATE_KEY = "klaviyo_email_subs_sync";
const DEADLINE_MS = 48_000;

/**
 * Klaviyo profiles → klaviyo_email_subs (email consent + dates) for the
 * email tenure cohorts. Resumable full scan: cursor kept in crm_sync_state.
 *   ?reset=1 starts a fresh pass; without it, continues or no-ops when done.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const url = new URL(req.url);
  const { data: st } = await db.from("crm_sync_state").select("value").eq("key", STATE_KEY).maybeSingle();
  let state = (url.searchParams.get("reset") === "1" ? null : (st?.value as any)) ?? null;
  if (!state) state = { cursor: null, done: false, rows: 0, pages: 0, startedAt: new Date().toISOString() };
  if (state.done) return NextResponse.json({ ok: true, done: true, ...state });

  const started = Date.now();
  let runRows = 0, runPages = 0;
  try {
    while (Date.now() - started < DEADLINE_MS) {
      const { rows, next } = await pageProfilesEmail(state.cursor);
      if (rows.length) {
        const { error } = await db.from("klaviyo_email_subs").upsert(rows.map((r) => ({ ...r, synced_at: new Date().toISOString() })), { onConflict: "profile_id" });
        if (error) throw new Error(error.message);
      }
      runRows += rows.length; runPages++;
      state.rows += rows.length; state.pages++;
      state.cursor = next;
      if (!next) { state.done = true; state.finishedAt = new Date().toISOString(); break; }
    }
  } catch (e: any) {
    await db.from("crm_sync_state").upsert({ key: STATE_KEY, value: state, updated_at: new Date().toISOString() }, { onConflict: "key" });
    const msg = String(e?.message ?? e);
    return NextResponse.json({ ok: false, error: msg, rateLimited: /429/.test(msg), runRows, runPages }, { status: /429/.test(msg) ? 200 : 500 });
  }
  await db.from("crm_sync_state").upsert({ key: STATE_KEY, value: state, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return NextResponse.json({ ok: true, done: state.done, runRows, runPages, totalRows: state.rows, totalPages: state.pages });
}
