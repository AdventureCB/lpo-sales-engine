import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { campaignNames, flowNames, seriesReport, valuesReport, conversionMetricId, syncEmailStatsWindow, KlaviyoRateLimited } from "@/lib/klaviyo-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STATE_KEY = "email_stats_sync";
const PAUSE_MS = 1500;

/**
 * Klaviyo email stats → email_stats_monthly.
 *   default      → nightly refresh: flows trailing 12 months (1 series report)
 *                  + campaigns current and previous month (2 values reports)
 *   ?backfill=1&years=3 → queue = flows per 12-month window + campaigns per
 *                  month, oldest last; state in crm_sync_state; stops on 429
 *                  and resumes on the next call
 *   ?probe=1&kind=campaign|flow → raw shape of one small report
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const db = supabaseAdmin();
  const now = new Date();
  const nowIso = now.toISOString();
  const monthStart = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString();
  const clamp = (iso: string) => (iso > nowIso ? nowIso : iso);
  const pause = () => new Promise((res) => setTimeout(res, PAUSE_MS));

  try {
    if (url.searchParams.get("probe") === "1") {
      const metric = await conversionMetricId();
      const kind = (url.searchParams.get("kind") === "flow" ? "flow" : "campaign") as "campaign" | "flow";
      const { rows, raw } = kind === "campaign"
        ? await valuesReport(kind, monthStart(-1), monthStart(0), metric)
        : await seriesReport(kind, monthStart(-1), nowIso, metric);
      return NextResponse.json({ metric, kind, rows: rows.slice(0, 5), rowCount: rows.length, dates: raw?.data?.attributes?.date_times, sample: JSON.stringify(raw?.data?.attributes?.results?.[0] ?? null).slice(0, 800) });
    }

    const [cn, fn] = await Promise.all([campaignNames(), flowNames()]);
    const names = (kind: "campaign" | "flow") => (kind === "campaign" ? cn : fn);
    const done: any[] = [];

    if (url.searchParams.get("backfill") === "1") {
      const years = Math.min(Math.max(Number(url.searchParams.get("years") ?? 3) || 3, 1), 5);
      const { data: st } = await db.from("crm_sync_state").select("value").eq("key", STATE_KEY).maybeSingle();
      const state = ((url.searchParams.get("reset") === "1" ? null : (st?.value as any)) ?? {}) as { pending?: string[]; doneCount?: number };
      if (!state.pending) {
        const pending: string[] = [];
        for (let k = 0; k < years; k++) pending.push(`flow|${monthStart(-12 * (k + 1) + 1)}|${monthStart(-12 * k + 1)}`);
        for (let m = 0; m < years * 12; m++) pending.push(`campaign|${monthStart(-m)}|${monthStart(-m + 1)}`);
        state.pending = pending;
        state.doneCount = 0;
      }
      const save = () => db.from("crm_sync_state").upsert({ key: STATE_KEY, value: state, updated_at: new Date().toISOString() }, { onConflict: "key" });
      const started = Date.now();
      while (state.pending.length && Date.now() - started < 45_000) {
        const [kind, s, e] = state.pending[0].split("|") as ["campaign" | "flow", string, string];
        try {
          done.push(await syncEmailStatsWindow(db, kind, s, clamp(e), names(kind)));
          state.pending.shift();
          state.doneCount = (state.doneCount ?? 0) + 1;
          await save();
          await pause();
        } catch (err: any) {
          await save();
          if (err instanceof KlaviyoRateLimited) return NextResponse.json({ ok: true, done, rateLimited: true, retryAfterS: err.retryAfterS, remaining: state.pending.length });
          throw err;
        }
      }
      return NextResponse.json({ ok: true, done, remaining: state.pending.length, complete: state.pending.length === 0 });
    }

    done.push(await syncEmailStatsWindow(db, "flow", monthStart(-11), nowIso, fn));
    await pause();
    done.push(await syncEmailStatsWindow(db, "campaign", monthStart(-1), monthStart(0), cn));
    await pause();
    done.push(await syncEmailStatsWindow(db, "campaign", monthStart(0), monthStart(1), cn));
    await db.from("crm_sync_state").upsert({ key: STATE_KEY + "_refresh", value: { at: new Date().toISOString(), done }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    return NextResponse.json({ ok: true, done });
  } catch (e: any) {
    if (e instanceof KlaviyoRateLimited) return NextResponse.json({ ok: false, rateLimited: true, retryAfterS: e.retryAfterS }, { status: 200 });
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
