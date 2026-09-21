import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { computeEngagement, laToday } from "@/lib/engagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Finished PT days never change — cache their computeEngagement result for an
// hour per warm instance so week/month views don't recompute 30 days each load.
const dayCache = new Map<string, { at: number; rows: Awaited<ReturnType<typeof computeEngagement>> }>();
async function engagementForDay(db: ReturnType<typeof supabaseAdmin>, date: string) {
  const isPast = date < laToday();
  const hit = dayCache.get(date);
  if (isPast && hit && Date.now() - hit.at < 3_600_000) return hit.rows;
  const rows = await computeEngagement(db, date);
  if (isPast) {
    if (dayCache.size > 120) dayCache.clear();
    dayCache.set(date, { at: Date.now(), rows });
  }
  return rows;
}

/** Sum a range of per-day rep rows into one row per rep (Kyle 9/21: week /
 * month / custom views). Times and counts add; first/last span the range;
 * per-cycle averages are cycle-weighted. */
function mergeDays(days: { date: string; rows: any[] }[]) {
  const merged = new Map<string, any>();
  const viewNum = new Map<string, number>();
  const wrapNum = new Map<string, number>();
  for (const { rows } of days) {
    for (const r of rows) {
      const cur = merged.get(r.email) ?? {
        name: r.name, email: r.email, dialingS: 0, talkingS: 0, inboundTalkS: 0, betweenS: 0, otherS: 0, idleS: 0, engagedS: 0,
        firstAt: null, lastAt: null, dials: 0, connects: 0, surfaces: {}, tools: {},
        actions: { emails: 0, texts: 0, notes: 0, scheduled: 0 }, cycles: 0, avgViewS: null, avgWrapS: null, activeDays: 0,
      };
      for (const k of ["dialingS", "talkingS", "inboundTalkS", "betweenS", "otherS", "idleS", "engagedS", "dials", "connects", "cycles"]) cur[k] += Number(r[k] ?? 0);
      if (r.firstAt && (!cur.firstAt || r.firstAt < cur.firstAt)) cur.firstAt = r.firstAt;
      if (r.lastAt && (!cur.lastAt || r.lastAt > cur.lastAt)) cur.lastAt = r.lastAt;
      for (const [k, v] of Object.entries(r.surfaces ?? {})) cur.surfaces[k] = (cur.surfaces[k] ?? 0) + Number(v);
      for (const [k, v] of Object.entries(r.tools ?? {})) cur.tools[k] = (cur.tools[k] ?? 0) + Number(v);
      for (const k of ["emails", "texts", "notes", "scheduled"]) cur.actions[k] += Number(r.actions?.[k] ?? 0);
      const c = Number(r.cycles ?? 0);
      if (c > 0) {
        if (r.avgViewS != null) viewNum.set(r.email, (viewNum.get(r.email) ?? 0) + r.avgViewS * c);
        if (r.avgWrapS != null) wrapNum.set(r.email, (wrapNum.get(r.email) ?? 0) + r.avgWrapS * c);
      }
      if (Number(r.engagedS ?? 0) > 0) cur.activeDays += 1;
      merged.set(r.email, cur);
    }
  }
  for (const cur of merged.values()) {
    if (cur.cycles > 0) {
      cur.avgViewS = viewNum.has(cur.email) ? (viewNum.get(cur.email) ?? 0) / cur.cycles : null;
      cur.avgWrapS = wrapNum.has(cur.email) ? (wrapNum.get(cur.email) ?? 0) / cur.cycles : null;
    }
  }
  return [...merged.values()].sort((a, b) => b.engagedS - a.engagedS);
}

/** Admin-only engagement readout: one PT day (+ 7-day trend), or a date
 * range (?start&end, ≤92 days) summed per rep with a per-day trend. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const params = new URL(req.url).searchParams;
  const isDay = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const db = supabaseAdmin();
  const { data: cfgRow } = await db.from("rep_activity_config").select("config").eq("id", true).maybeSingle();
  const kpiHours = Number((cfgRow?.config as any)?.kpi_hours ?? 4);

  // ── Range mode ──
  if (isDay(params.get("start")) && isDay(params.get("end"))) {
    let start = params.get("start")!;
    let end = params.get("end")!;
    if (start > end) [start, end] = [end, start];
    if (end > laToday()) end = laToday();
    const dates: string[] = [];
    for (let d = new Date(`${start}T12:00:00Z`); dates.length < 92; d = new Date(d.getTime() + 86_400_000)) {
      const s = d.toISOString().slice(0, 10);
      if (s > end) break;
      dates.push(s);
    }
    const days: { date: string; rows: any[] }[] = [];
    for (const d of dates) days.push({ date: d, rows: await engagementForDay(db, d) });
    const reps = mergeDays(days);
    const trend = days.map(({ date, rows }) => ({ date, byRep: Object.fromEntries(rows.map((r: any) => [r.email, r.engagedS])) }));
    const activeDays = days.filter(({ rows }) => rows.some((r: any) => Number(r.engagedS ?? 0) > 0)).length;
    const { data: toolCfg } = await db.from("crm_sync_state").select("value").eq("key", "tool_links").maybeSingle();
    const toolLabels: Record<string, { label: string; emoji: string }> = {};
    for (const t of ((toolCfg?.value as any)?.tools ?? []) as { key: string; label: string; emoji: string }[]) {
      if (t.key && t.label) toolLabels[t.key] = { label: t.label, emoji: t.emoji ?? "🧰" };
    }
    return NextResponse.json({ start, end, days: dates.length, activeDays, kpiHours, reps, trend, toolLabels });
  }

  // ── Single-day mode ──
  const date = params.get("date") ?? laToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "bad date" }, { status: 400 });

  const reps = await engagementForDay(db, date);

  // Display names for tool slices — reps' custom tools have generated keys
  // (tool57474 = Kyle's Gmail tile); label them as configured in 🧰 Tools.
  const { data: toolCfg } = await db.from("crm_sync_state").select("value").eq("key", "tool_links").maybeSingle();
  const toolLabels: Record<string, { label: string; emoji: string }> = {};
  for (const t of ((toolCfg?.value as any)?.tools ?? []) as { key: string; label: string; emoji: string }[]) {
    if (t.key && t.label) toolLabels[t.key] = { label: t.label, emoji: t.emoji ?? "🧰" };
  }

  // 7-day engaged trend ending on the requested date (skip if trend=0).
  const trend: { date: string; byRep: Record<string, number> }[] = [];
  if (params.get("trend") !== "0") {
    const base = new Date(`${date}T12:00:00Z`);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(base.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      if (d === date) {
        trend.push({ date: d, byRep: Object.fromEntries(reps.map((r) => [r.email, r.engagedS])) });
      } else {
        const day = await engagementForDay(db, d);
        trend.push({ date: d, byRep: Object.fromEntries(day.map((r) => [r.email, r.engagedS])) });
      }
    }
  }

  return NextResponse.json({ date, kpiHours, reps, trend, toolLabels });
}
