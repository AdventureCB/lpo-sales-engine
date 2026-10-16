import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-rep KPIs (Kyle 10/16) — definitions in the route/page headers:
 * WORKED = ≥1 real outbound touch; CONFIRMED = won, credited to owner at
 * close; PRESUMED = + Deposit Placed; cohorts by first-touch month (<60d =
 * maturing). CAPACITY = on-plan book (touched in window OR future activity),
 * staleness of the unplanned, distinct deals/working day × 21.
 * Computed hourly by /api/cron/rep-kpis into rep_kpi_snapshots; the page reads
 * the snapshot (admins can force a fresh compute).
 */
const hours = (h: number) => h * 3_600_000;

export interface RepKpis { email: string; name: string; book: any; throughput: any; conversion: any; reprospect: any }

export async function computeRepKpis(db: SupabaseClient, days: number, onlyRep: string | null = null): Promise<{ reps: RepKpis[]; weekly?: any[]; computedAt: string }> {
  const now = Date.now();
  const windowStart = new Date(now - hours(24 * days)).toISOString();

  // The touches RPC returns ~7k rows; PostgREST caps one read at 1,000, so page it.
  const fetchTouches = async () => {
    const all: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.rpc("rep_deal_touches", { p_window_start: windowStart }).range(from, from + 999);
      if (error) return { data: null, error };
      all.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    return { data: all, error: null };
  };
  let repsQ = db.from("reps").select("email, name, pipedrive_user_id").eq("active", true).not("pipedrive_user_id", "is", null);
  if (onlyRep) repsQ = repsQ.ilike("email", onlyRep);
  const [{ data: reps }, { data: touchesRaw, error: tErr }, { data: stageRows }, { data: pendingRows }, { data: checkouts }] = await Promise.all([
    repsQ,
    fetchTouches(),
    db.from("crm_stages").select("id, name"),
    db.from("crm_activities").select("deal_id").is("done_at", null).gt("due_at", new Date(now).toISOString()).not("deal_id", "is", null).limit(20000),
    db.from("crm_reprospect_checkouts").select("deal_id, rep_email, checked_out_at, expires_at, released_at").gte("checked_out_at", windowStart),
  ]);
  if (tErr) throw new Error(tErr.message);
  const depositStageIds = new Set((stageRows ?? []).filter((s: any) => /deposit/i.test(s.name)).map((s: any) => s.id));
  const hasPlan = new Set((pendingRows ?? []).map((p: any) => p.deal_id as string));

  // Deals referenced by any touch, plus every open owned deal (for coverage).
  const touches = (touchesRaw ?? []) as { rep_email: string; deal_id: string; first_touch: string; last_touch: string; touches_window: number; touches_total: number }[];
  const dealIds = new Set(touches.map((t) => t.deal_id));
  const dealMap = new Map<string, { id: string; status: string; owner: number | null; stage_id: string | null; created_at: string; won_at: string | null; contact_count: number; attempt_count: number }>();
  const load = async (ids: string[]) => {
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await db.from("crm_deals").select("id, status, owner_pipedrive_id, stage_id, created_at, won_at, contact_count, attempt_count").in("id", ids.slice(i, i + 500));
      for (const d of data ?? []) dealMap.set(d.id, { id: d.id, status: d.status, owner: d.owner_pipedrive_id, stage_id: d.stage_id, created_at: d.created_at, won_at: d.won_at, contact_count: d.contact_count ?? 0, attempt_count: d.attempt_count ?? 0 });
    }
  };
  await load([...dealIds]);
  const repIds = (reps ?? []).map((r: any) => r.pipedrive_user_id as number);
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("crm_deals").select("id, status, owner_pipedrive_id, stage_id, created_at, won_at, contact_count, attempt_count").eq("status", "open").in("owner_pipedrive_id", repIds).range(from, from + 999);
    for (const d of data ?? []) dealMap.set(d.id, { id: d.id, status: d.status, owner: d.owner_pipedrive_id, stage_id: d.stage_id, created_at: d.created_at, won_at: d.won_at, contact_count: d.contact_count ?? 0, attempt_count: d.attempt_count ?? 0 });
    if (!data || data.length < 1000) break;
  }

  // Working days per rep in the window (days with any engagement interval), fallback = days with a touch.
  const workDays = new Map<string, Set<string>>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("rep_activity_intervals").select("rep_email, started_at").gte("started_at", windowStart).range(from, from + 999);
    for (const r of data ?? []) (workDays.get(r.rep_email) ?? workDays.set(r.rep_email, new Set()).get(r.rep_email)!).add(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(r.started_at)));
    if (!data || data.length < 1000) break;
  }

  const monthKey = (iso: string) => iso.slice(0, 7);
  const cohortMonths: string[] = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(now); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); cohortMonths.push(d.toISOString().slice(0, 7)); }

  const out = (reps ?? []).map((rep: any) => {
    const mine = touches.filter((t) => t.rep_email === rep.email);
    const owned = [...dealMap.values()].filter((d) => d.status === "open" && d.owner === rep.pipedrive_user_id);
    const lastTouchByDeal = new Map(mine.map((t) => [t.deal_id, t.last_touch]));

    // Coverage of the open book.
    const touchedInWindow = new Set(mine.filter((t) => t.touches_window > 0).map((t) => t.deal_id));
    const onPlan = owned.filter((d) => touchedInWindow.has(d.id) || hasPlan.has(d.id)).length;
    const attempted = owned.filter((d) => d.attempt_count > 0).length;
    const contacted = owned.filter((d) => d.contact_count > 0).length;
    const buckets = { "0-7": 0, "8-14": 0, "15-30": 0, "31-60": 0, "60+": 0, never: 0 } as Record<string, number>;
    for (const d of owned) {
      if (hasPlan.has(d.id)) continue; // planned = not stale
      const lt = lastTouchByDeal.get(d.id);
      if (!lt) { buckets.never++; continue; }
      const age = (now - Date.parse(lt)) / 86_400_000;
      buckets[age <= 7 ? "0-7" : age <= 14 ? "8-14" : age <= 30 ? "15-30" : age <= 60 ? "31-60" : "60+"]++;
    }

    // Throughput.
    const wd = workDays.get(rep.email)?.size ?? new Set(mine.filter((t) => t.touches_window > 0).map((t) => t.last_touch.slice(0, 10))).size;
    const touchesWindow = mine.reduce((n, t) => n + t.touches_window, 0);
    const distinctPerDay = wd ? touchedInWindow.size / wd : 0;
    const impliedCapacity = Math.round(distinctPerDay * 21);

    // Conversion cohorts by month of first touch.
    const cohorts = cohortMonths.map((m) => {
      const rows = mine.filter((t) => monthKey(t.first_touch) === m);
      let confirmed = 0, presumed = 0;
      for (const t of rows) {
        const d = dealMap.get(t.deal_id);
        if (!d) continue;
        const won = d.status === "won" && d.owner === rep.pipedrive_user_id;
        const dep = d.status === "open" && d.stage_id != null && depositStageIds.has(d.stage_id) && d.owner === rep.pipedrive_user_id;
        if (won) confirmed++;
        if (won || dep) presumed++;
      }
      const ageDays = (now - Date.parse(`${m}-01T00:00:00Z`)) / 86_400_000;
      return { month: m, worked: rows.length, confirmed, presumed, maturing: ageDays < 60 };
    });
    const workedAll = mine.length;
    const confirmedAll = cohorts.reduce((n, c) => n + c.confirmed, 0);
    const presumedAll = cohorts.reduce((n, c) => n + c.presumed, 0);
    const matured = cohorts.filter((c) => !c.maturing);
    const workedMatured = matured.reduce((n, c) => n + c.worked, 0);

    // Reprospecting.
    const myCheckouts = (checkouts ?? []).filter((c: any) => c.rep_email === rep.email);
    const claimed = myCheckouts.length;
    let attemptedInHold = 0, takenOver = 0;
    for (const c of myCheckouts as any[]) {
      const t = mine.find((x) => x.deal_id === c.deal_id);
      if (t && t.last_touch >= c.checked_out_at) attemptedInHold++;
      const d = dealMap.get(c.deal_id);
      if (d && d.owner === rep.pipedrive_user_id) takenOver++;
    }

    return {
      email: rep.email, name: rep.name,
      book: { open: owned.length, onPlan, planned: owned.filter((d) => hasPlan.has(d.id)).length, touchedInWindow: touchedInWindow.size, attempted, contacted, staleness: buckets },
      throughput: { workDays: wd, touches: touchesWindow, distinctDeals: touchedInWindow.size, touchesPerDay: wd ? +(touchesWindow / wd).toFixed(1) : 0, dealsPerDay: +distinctPerDay.toFixed(1), impliedCapacity },
      conversion: { workedAll, confirmedAll, presumedAll, workedMatured, confirmedMatured: matured.reduce((n, c) => n + c.confirmed, 0), presumedMatured: matured.reduce((n, c) => n + c.presumed, 0), cohorts },
      reprospect: { claimed, attemptedInHold, takenOver },
    };
  });

  // Sales reps only: anyone with no touches in the window and a trivial book
  // (CS / admin logins that exist in reps for other reasons) is left off.
  const shown = onlyRep ? out : out.filter((r: any) => r.throughput.touches > 0 || r.book.open >= 10);
  // Single-rep dashboard: add the 12-week activity series.
  let weekly: any[] | undefined;
  if (onlyRep && shown.length) {
    const { data } = await db.rpc("rep_weekly_touches", { p_rep_email: onlyRep, p_since: new Date(now - hours(24 * 7 * 12)).toISOString() });
    weekly = (data ?? []).map((w: any) => ({ week: w.week, touches: Number(w.touches), deals: Number(w.deals), dials: Number(w.dials), conversations: Number(w.conversations), emails: Number(w.emails), texts: Number(w.texts) }));
  }
  return { reps: shown.sort((a: any, b: any) => b.book.open - a.book.open), weekly, computedAt: new Date(now).toISOString() };
}

export async function computeWeekly(db: SupabaseClient, repEmail: string): Promise<any[]> {
  const { data } = await db.rpc("rep_weekly_touches", { p_rep_email: repEmail, p_since: new Date(Date.now() - hours(24 * 7 * 12)).toISOString() });
  return (data ?? []).map((w: any) => ({ week: w.week, touches: Number(w.touches), deals: Number(w.deals), dials: Number(w.dials), conversations: Number(w.conversations), emails: Number(w.emails), texts: Number(w.texts) }));
}
