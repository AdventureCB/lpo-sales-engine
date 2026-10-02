import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { campaignNames, flowNames, seriesReport, conversionMetricId, syncEmailStatsWindow, KlaviyoRateLimited } from "@/lib/klaviyo-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STATE_KEY = "email_stats_sync";

/**
 * Klaviyo email stats → email_stats_monthly.
 *   default      → refresh the trailing 12 months (campaigns + flows; 2 reports)
 *   ?backfill=1  → work through older 12-month windows (state in crm_sync_state);
 *                  stops on 429 and resumes next call
 *   ?years=3     → how far back the backfill goes (default 3)
 *   ?probe=1     → raw shape of one small report (diagnostics)
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const db = supabaseAdmin();
  const now = new Date();
  const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m, 1)).toISOString();
  const thisMonth = monthStart(now.getUTCFullYear(), now.getUTCMonth());
  const nextMonth = monthStart(now.getUTCFullYear(), now.getUTCMonth() + 1);

  try {
    if (url.searchParams.get("probe") === "1") {
      const metric = await conversionMetricId();
      const kind = (url.searchParams.get("kind") === "flow" ? "flow" : "campaign") as "campaign" | "flow";
      const { rows, raw } = await seriesReport(kind, monthStart(now.getUTCFullYear(), now.getUTCMonth() - 1), now.toISOString(), metric);
      return NextResponse.json({ metric, kind, rows: rows.slice(0, 5), rowCount: rows.length, dates: raw?.data?.attributes?.date_times, sample: JSON.stringify(raw?.data?.attributes?.results?.[0] ?? null).slice(0, 800) });
    }

    const [cn, fn] = await Promise.all([campaignNames(), flowNames()]);
    const done: any[] = [];

    if (url.searchParams.get("backfill") === "1") {
      const years = Math.min(Math.max(Number(url.searchParams.get("years") ?? 3) || 3, 1), 5);
      const { data: st } = await db.from("crm_sync_state").select("value").eq("key", STATE_KEY).maybeSingle();
      const state = ((st?.value as any) ?? {}) as { pending?: string[]; doneWindows?: string[] };
      if (!state.pending) {
        // windows: [now-12mo, now), [now-24mo, now-12mo) … oldest last; each kind separately
        const pending: string[] = [];
        for (let k = 0; k < years; k++) {
          const s = monthStart(now.getUTCFullYear(), now.getUTCMonth() - 12 * (k + 1) + 1);
          const e = k === 0 ? nextMonth : monthStart(now.getUTCFullYear(), now.getUTCMonth() - 12 * k + 1);
          pending.push(`campaign|${s}|${e}`, `flow|${s}|${e}`);
        }
        state.pending = pending;
        state.doneWindows = [];
      }
      while (state.pending.length) {
        const [kind, s, e] = state.pending[0].split("|") as ["campaign" | "flow", string, string];
        try {
          const r = await syncEmailStatsWindow(db, kind, s, e > now.toISOString() ? now.toISOString() : e, kind === "campaign" ? cn : fn);
          done.push(r);
          state.doneWindows!.push(state.pending.shift()!);
          await db.from("crm_sync_state").upsert({ key: STATE_KEY, value: state, updated_at: new Date().toISOString() }, { onConflict: "key" });
          await new Promise((res) => setTimeout(res, 1500));
        } catch (e: any) {
          await db.from("crm_sync_state").upsert({ key: STATE_KEY, value: state, updated_at: new Date().toISOString() }, { onConflict: "key" });
          if (e instanceof KlaviyoRateLimited) return NextResponse.json({ ok: true, done, rateLimited: true, retryAfterS: e.retryAfterS, remaining: state.pending.length });
          throw e;
        }
      }
      return NextResponse.json({ ok: true, done, remaining: 0, complete: true });
    }

    // Nightly refresh: trailing 12 months, both kinds.
    const s = monthStart(now.getUTCFullYear(), now.getUTCMonth() - 11);
    for (const kind of ["campaign", "flow"] as const) {
      done.push(await syncEmailStatsWindow(db, kind, s, now.toISOString(), kind === "campaign" ? cn : fn));
      await new Promise((res) => setTimeout(res, 1500));
    }
    await db.from("crm_sync_state").upsert({ key: STATE_KEY + "_refresh", value: { at: new Date().toISOString(), done }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    return NextResponse.json({ ok: true, done, thisMonth });
  } catch (e: any) {
    if (e instanceof KlaviyoRateLimited) return NextResponse.json({ ok: false, rateLimited: true, retryAfterS: e.retryAfterS }, { status: 200 });
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
