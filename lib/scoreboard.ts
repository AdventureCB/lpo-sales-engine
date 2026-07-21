/**
 * Scoreboard rollups (Module 3). Pure functions — the API route feeds rows
 * in, this buckets them by day in the app timezone and shapes the exact
 * structure the approved prototype renders: 7 weekday buckets for every
 * range (day = today's weekday only, month = summed by weekday).
 *
 * Metric definitions (FRAMEWORK.md):
 * - dials: outgoing calls placed
 * - conversations: outgoing calls classified `conversation` + inbound calls answered
 * - VMs left: outgoing calls classified `voicemail`, or disposition vm_dropped
 * - talk time: summed duration on conversation calls
 * - connect rate: outgoing conversations ÷ dials
 */

export interface CallRow {
  rep_id: string | null;
  direction: "incoming" | "outgoing" | null;
  started_at: string | null;
  answered_at: string | null;
  duration_s: number | null;
  classification: string | null;
  disposition: string | null;
}

export interface MessageRow {
  rep_id: string | null;
  direction: "incoming" | "outgoing" | null;
  sent_at: string | null;
}

export interface JourneyRow {
  rep_id: string | null;
  state: string;
  confirmed_at: string | null;
  commission_amount_cents: number;
}

export interface RepRow {
  id: string;
  name: string;
}

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface DayInfo {
  date: string; // YYYY-MM-DD in app tz
  weekdayIdx: number; // 0 = Mon
}

function dayInfo(instant: Date, timeZone: string): DayInfo {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayIdx = DAY_LABELS.indexOf(get("weekday"));
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekdayIdx };
}

function prettyDate(date: string, withWeekday: boolean): string {
  const d = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    ...(withWeekday ? { weekday: "short" } : {}),
    month: "short",
    day: "numeric",
  })
    .format(d)
    .replace(",", "");
}

function formatTalk(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

interface Tally {
  dials: number;
  convOut: number;
  convIn: number;
  vm: number;
  talkS: number;
  texts: number;
  textsIn: number;
}

const emptyTally = (): Tally => ({
  dials: 0,
  convOut: 0,
  convIn: 0,
  vm: 0,
  talkS: 0,
  texts: 0,
  textsIn: 0,
});

function tallyCall(t: Tally, c: CallRow) {
  const isConvOut = c.direction === "outgoing" && c.classification === "conversation";
  const isConvIn = c.direction === "incoming" && c.answered_at !== null;
  if (c.direction === "outgoing") t.dials++;
  if (isConvOut) t.convOut++;
  if (isConvIn) t.convIn++;
  if (c.direction === "outgoing" && (c.classification === "voicemail" || c.disposition === "vm_dropped"))
    t.vm++;
  if (isConvOut || isConvIn) t.talkS += c.duration_s ?? 0;
}

export function buildScoreboard(
  reps: RepRow[],
  calls: CallRow[],
  messages: MessageRow[],
  journeys: JourneyRow[],
  timeZone: string,
  now: Date
) {
  // Map every instant we might see to an app-tz calendar day.
  const dayByDate = new Map<string, DayInfo>();
  for (let k = -45; k <= 7; k++) {
    const info = dayInfo(new Date(now.getTime() + k * 86400_000), timeZone);
    dayByDate.set(info.date, info);
  }

  const today = dayInfo(now, timeZone);
  const monthPrefix = today.date.slice(0, 7);

  // The week containing today, Monday-first.
  const weekDates: string[] = [];
  for (let k = -today.weekdayIdx; k <= 6 - today.weekdayIdx; k++) {
    weekDates.push(dayInfo(new Date(now.getTime() + k * 86400_000), timeZone).date);
  }

  // rep -> date -> tally
  const perRepDay = new Map<string, Map<string, Tally>>();
  for (const rep of reps) perRepDay.set(rep.id, new Map());
  for (const c of calls) {
    if (!c.rep_id || !c.started_at) continue;
    const days = perRepDay.get(c.rep_id);
    if (!days) continue;
    const date = dayInfo(new Date(c.started_at), timeZone).date;
    let t = days.get(date);
    if (!t) days.set(date, (t = emptyTally()));
    tallyCall(t, c);
  }
  // Texts: outgoing credit the sender; inbound credit the receiving line's
  // owner (Parker/Jackson lines only — shared-line inbound is stored but
  // deliberately not counted).
  for (const m of messages) {
    if (!m.sent_at || !m.rep_id) continue;
    const days = perRepDay.get(m.rep_id);
    if (!days) continue;
    const date = dayInfo(new Date(m.sent_at), timeZone).date;
    let t = days.get(date);
    if (!t) days.set(date, (t = emptyTally()));
    if (m.direction === "incoming") t.textsIn++;
    else if (m.direction === "outgoing") t.texts++;
  }

  // Commission MTD is the same figure on every range (tile is labeled MTD).
  const commMtdCents = new Map<string, number>();
  for (const j of journeys) {
    if (!j.rep_id || !j.confirmed_at) continue;
    if (!["confirmed", "walk_in", "paid"].includes(j.state)) continue;
    if (dayInfo(new Date(j.confirmed_at), timeZone).date.slice(0, 7) !== monthPrefix) continue;
    commMtdCents.set(j.rep_id, (commMtdCents.get(j.rep_id) ?? 0) + j.commission_amount_cents);
  }

  const repKey = (r: RepRow) => r.name.split(" ")[0].toLowerCase();

  function buildRange(datesFor: (repDays: Map<string, Tally>) => string[], sub: string) {
    const dials: Record<string, number[]> = {};
    const conv: Record<string, number[]> = {};
    const tiles: Record<string, Record<string, string | number>> = {};
    for (const rep of reps) {
      const days = perRepDay.get(rep.id)!;
      const series = { dials: new Array(7).fill(0), conv: new Array(7).fill(0) };
      const total = emptyTally();
      for (const date of datesFor(days)) {
        const t = days.get(date);
        if (!t) continue;
        const wi = dayByDate.get(date)?.weekdayIdx ?? -1;
        if (wi >= 0) {
          series.dials[wi] += t.dials;
          series.conv[wi] += t.convOut + t.convIn;
        }
        total.dials += t.dials;
        total.convOut += t.convOut;
        total.convIn += t.convIn;
        total.vm += t.vm;
        total.talkS += t.talkS;
        total.texts += t.texts;
        total.textsIn += t.textsIn;
      }
      const key = repKey(rep);
      dials[key] = series.dials;
      conv[key] = series.conv;
      tiles[key] = {
        dials: total.dials,
        conv: total.convOut, // outgoing only — same numerator the rate uses
        convIn: total.convIn,
        vm: total.vm,
        texts: total.texts,
        textsIn: total.textsIn,
        talk: formatTalk(total.talkS),
        rate: total.dials > 0 ? `${Math.round((total.convOut / total.dials) * 100)}%` : "—",
        comm: `$${Math.round((commMtdCents.get(rep.id) ?? 0) / 100)}`,
      };
    }
    return { sub, dials, conv, tiles };
  }

  const monthDatesFor = (days: Map<string, Tally>) =>
    [...days.keys()].filter((d) => d.startsWith(monthPrefix) && d <= today.date);

  return {
    reps: reps.map((r) => ({
      key: repKey(r),
      name: r.name,
      initials: r.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase(),
    })),
    days: DAY_LABELS,
    ranges: {
      day: buildRange(
        () => [today.date],
        `Today · ${prettyDate(today.date, true)}`
      ),
      week: buildRange(
        () => weekDates,
        `${prettyDate(weekDates[0], true)} – ${prettyDate(weekDates[6], true)}`
      ),
      month: buildRange(
        monthDatesFor,
        `${prettyDate(`${monthPrefix}-01`, false)} – ${prettyDate(today.date, false)} · summed by weekday`
      ),
    },
  };
}
