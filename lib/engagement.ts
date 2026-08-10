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

  const [{ data: calls }, { data: acts }] = await Promise.all([
    db
      .from("call_events")
      .select("rep_id, direction, started_at, answered_at, completed_at, duration_s")
      .in("rep_id", repIds.length ? repIds : ["00000000-0000-0000-0000-000000000000"])
      .gte("started_at", startIso)
      .lt("started_at", endIso),
    db
      .from("rep_activity_intervals")
      .select("rep_email, state, started_at, ended_at")
      .in("rep_email", emails.length ? emails : ["-"])
      .gte("ended_at", startIso)
      .lte("started_at", endIso),
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

    for (const a of (acts ?? []).filter((a) => a.rep_email === rep.email)) {
      const s = Date.parse(a.started_at), e = Date.parse(a.ended_at);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      // Client-claimed talking/dialing demote to "between": presence during a
      // call is real engagement evidence, but call time itself only counts
      // when call_events corroborates (which then wins on precedence).
      const prec = a.state === "other" ? PREC.other : PREC.between;
      segs.push({ s: Math.max(s, startMs), e: Math.min(e, capMs), prec });
    }

    const agg = sweep(segs, capMs);
    const times = segs.filter((x) => x.e > x.s);
    const first = times.length ? Math.min(...times.map((x) => x.s)) : null;
    const last = times.length ? Math.max(...times.map((x) => x.e)) : null;
    const spanS = first != null && last != null ? (last - first) / 1000 : 0;

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
    });
  }
  return out;
}
