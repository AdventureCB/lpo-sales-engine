import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Rep engagement compute (admin KPI: ≥4h/day engaged in calling).
 *
 * Three layers of truth, merged by a precedence sweep:
 *   talking/dialing — AUTHORITATIVE from call_events (works for Quo and
 *   Telnyx calls alike; client claims for these are discarded);
 *   between/other  — client tracker intervals (input-live, surface-tagged);
 *   idle           — computed, not stored: the uncovered gap inside the
 *   day's active span (first→last observed activity).
 *
 * Precedence talking > dialing > between > other means overlapping evidence
 * can never double-count a second, and multiple devices union cleanly.
 */

export interface RepEngagement {
  repId: string;
  name: string;
  email: string;
  dialingS: number;
  talkingS: number;
  inboundTalkS: number; // subset of talkingS, tagged so the KPI can exclude it
  betweenS: number;
  otherS: number;
  idleS: number;
  engagedS: number; // dialing + talking + between
  firstAt: string | null;
  lastAt: string | null;
  dials: number;
  connects: number;
  // Where the NON-call active time went, by surface (call-covered spans
  // subtracted so this never double-shows talk/dial time).
  surfaces: Record<string, number>;
  // What they produced: rep-authored records that day.
  actions: { emails: number; texts: number; notes: number; scheduled: number };
  // Dialer micro-timings (dialer_cycle_stats).
  cycles: number;
  avgViewS: number | null; // lead painted → first dial press
  avgWrapS: number | null; // call end → Next press
}

/** UTC bounds of a Pacific-time calendar day (DST-aware via Intl). */
export function laDayBounds(dateStr: string): { startMs: number; endMs: number } {
  const offH = (d: Date): number => {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT-08:00";
    const m = part.match(/GMT([+-])(\d{1,2})/);
    return m ? (m[1] === "-" ? -1 : 1) * Number(m[2]) : -8;
  };
  const noonUtc = new Date(`${dateStr}T12:00:00Z`);
  const startMs = new Date(`${dateStr}T00:00:00Z`).getTime() - offH(noonUtc) * 3600_000;
  return { startMs, endMs: startMs + 24 * 3600_000 };
}

export function laToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

type Seg = { s: number; e: number; prec: number; inbound?: boolean };
const PREC = { talking: 3, dialing: 2, between: 1, other: 0 } as const;

type Span = { s: number; e: number };
/** Sort + merge overlapping spans. */
function unionSpans(list: Span[]): Span[] {
  const sorted = list.filter((x) => x.e > x.s).sort((a, b) => a.s - b.s);
  const out: Span[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.s <= last.e) last.e = Math.max(last.e, x.e);
    else out.push({ ...x });
  }
  return out;
}
/** Subtract (already-unioned) cuts from (already-unioned) spans. */
function subtractSpans(spans: Span[], cuts: Span[]): Span[] {
  const out: Span[] = [];
  for (const sp of spans) {
    let cur = sp.s;
    for (const c of cuts) {
      if (c.e <= cur || c.s >= sp.e) continue;
      if (c.s > cur) out.push({ s: cur, e: Math.min(c.s, sp.e) });
      cur = Math.max(cur, c.e);
      if (cur >= sp.e) break;
    }
    if (cur < sp.e) out.push({ s: cur, e: sp.e });
  }
  return out;
}

function sweep(segs: Seg[], capMs: number) {
  const clean = segs.filter((x) => x.e > x.s);
  const bounds = [...new Set(clean.flatMap((x) => [x.s, x.e]))].sort((a, b) => a - b);
  const out = { talking: 0, dialing: 0, between: 0, other: 0, inboundTalk: 0, covered: 0 };
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = Math.min(bounds[i + 1], capMs);
    if (b <= a) continue;
    let best = -1, inbound = false;
    for (const x of clean) {
      if (x.s <= a && x.e >= b && x.prec > best) { best = x.prec; inbound = !!x.inbound; }
    }
    if (best < 0) continue;
    const dur = (b - a) / 1000;
    out.covered += dur;
    if (best === 3) { out.talking += dur; if (inbound) out.inboundTalk += dur; }
    else if (best === 2) out.dialing += dur;
    else if (best === 1) out.between += dur;
    else out.other += dur;
  }
  return out;
}

export async function computeEngagement(db: SupabaseClient, dateStr: string): Promise<RepEngagement[]> {
  const { startMs, endMs } = laDayBounds(dateStr);
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const nowMs = Date.now();
  const capMs = Math.min(endMs, nowMs); // today: don't count the future

  const { data: reps } = await db
    .from("reps")
    .select("id, name, email")
    .eq("active", true)
    .not("email", "is", null);

  const repIds = (reps ?? []).map((r) => r.id);
  const emails = (reps ?? []).map((r) => r.email as string);

  const [{ data: calls }, { data: acts }, { data: authored }, { data: cycles }] = await Promise.all([
    db
      .from("call_events")
      .select("rep_id, direction, started_at, answered_at, completed_at, duration_s")
      .in("rep_id", repIds.length ? repIds : ["00000000-0000-0000-0000-000000000000"])
      .gte("started_at", startIso)
      .lt("started_at", endIso),
    db
      .from("rep_activity_intervals")
      .select("rep_email, state, surface, started_at, ended_at")
      .in("rep_email", emails.length ? emails : ["-"])
      .gte("ended_at", startIso)
      .lte("started_at", endIso),
    db
      .from("crm_activities")
      .select("actor, type, due_at, meta")
      .in("actor", emails.length ? emails : ["-"])
      .gte("occurred_at", startIso)
      .lt("occurred_at", endIso)
      .limit(3000),
    db
      .from("dialer_cycle_stats")
      .select("rep_email, view_ms, wrap_ms")
      .in("rep_email", emails.length ? emails : ["-"])
      .gte("at", startIso)
      .lt("at", endIso)
      .limit(3000),
  ]);

  const out: RepEngagement[] = [];
  for (const rep of reps ?? []) {
    const segs: Seg[] = [];
    let dials = 0, connects = 0;

    for (const c of (calls ?? []).filter((c) => c.rep_id === rep.id)) {
      const st = c.started_at ? Date.parse(c.started_at) : NaN;
      if (!Number.isFinite(st)) continue;
      const ans = c.answered_at ? Date.parse(c.answered_at) : null;
      const done = c.completed_at
        ? Date.parse(c.completed_at)
        : ans != null && c.duration_s
          ? ans + c.duration_s * 1000
          : null;
      if (c.direction === "outgoing") {
        dials++;
        // Ring/setup time: start → answer (or hangup on no-answer; conservative fallback 45s).
        const dialEnd = ans ?? done ?? st + Math.min((c.duration_s ?? 45), 120) * 1000;
        segs.push({ s: Math.max(st, startMs), e: Math.min(dialEnd, capMs), prec: PREC.dialing });
        if (ans != null) {
          connects++;
          segs.push({ s: Math.max(ans, startMs), e: Math.min(done ?? ans, capMs), prec: PREC.talking });
        }
      } else if (ans != null) {
        segs.push({ s: Math.max(ans, startMs), e: Math.min(done ?? ans, capMs), prec: PREC.talking, inbound: true });
      }
    }

    const callSpans: { s: number; e: number }[] = [];
    for (const c of segs) callSpans.push({ s: c.s, e: c.e }); // call segs pushed so far

    const bySurface = new Map<string, { s: number; e: number }[]>();
    for (const a of (acts ?? []).filter((a) => a.rep_email === rep.email)) {
      const s = Date.parse(a.started_at), e = Date.parse(a.ended_at);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      // Client-claimed talking/dialing demote to "between": presence during a
      // call is real engagement evidence, but call time itself only counts
      // when call_events corroborates (which then wins on precedence).
      const prec = a.state === "other" ? PREC.other : PREC.between;
      const cs = Math.max(s, startMs), ce = Math.min(e, capMs);
      segs.push({ s: cs, e: ce, prec });
      const surf = a.surface ?? "?";
      (bySurface.get(surf) ?? bySurface.set(surf, []).get(surf)!).push({ s: cs, e: ce });
    }

    // Per-surface seconds: union-merge each surface's intervals, then subtract
    // call-covered spans so surface time = where NON-call active time went.
    const surfaces: Record<string, number> = {};
    for (const [surf, list] of bySurface) {
      const merged = unionSpans(list);
      const net = subtractSpans(merged, unionSpans(callSpans));
      const sec = Math.round(net.reduce((acc, x) => acc + (x.e - x.s), 0) / 1000);
      if (sec >= 30) surfaces[surf] = sec;
    }

    const agg = sweep(segs, capMs);
    const times = segs.filter((x) => x.e > x.s);
    const first = times.length ? Math.min(...times.map((x) => x.s)) : null;
    const last = times.length ? Math.max(...times.map((x) => x.e)) : null;
    const spanS = first != null && last != null ? (last - first) / 1000 : 0;

    // What they produced that day (outbound only for emails — the Gmail sweep
    // logs inbound rows under the same actor sometimes).
    const mine = (authored ?? []).filter((a) => a.actor === rep.email);
    const actions = {
      emails: mine.filter((a) => a.type === "email" && ((a.meta as any)?.direction ?? "outbound") !== "inbound").length,
      texts: mine.filter((a) => a.type === "sms").length,
      notes: mine.filter((a) => a.type === "note").length,
      scheduled: mine.filter((a) => a.due_at != null).length,
    };

    const myCycles = (cycles ?? []).filter((c) => c.rep_email === rep.email);
    const views = myCycles.map((c) => c.view_ms).filter((v): v is number => v != null);
    const wraps = myCycles.map((c) => c.wrap_ms).filter((v): v is number => v != null);
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length / 1000) : null);

    out.push({
      repId: rep.id,
      name: rep.name,
      email: rep.email as string,
      dialingS: Math.round(agg.dialing),
      talkingS: Math.round(agg.talking),
      inboundTalkS: Math.round(agg.inboundTalk),
      betweenS: Math.round(agg.between),
      otherS: Math.round(agg.other),
      idleS: Math.round(Math.max(spanS - agg.covered, 0)),
      engagedS: Math.round(agg.dialing + agg.talking + agg.between),
      firstAt: first != null ? new Date(first).toISOString() : null,
      lastAt: last != null ? new Date(last).toISOString() : null,
      dials,
      connects,
      surfaces,
      actions,
      cycles: myCycles.length,
      avgViewS: avg(views),
      avgWrapS: avg(wraps),
    });
  }
  return out;
}
