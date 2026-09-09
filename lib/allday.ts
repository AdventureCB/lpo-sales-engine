/**
 * All-day activity convention (client + server safe). A due_at at exactly
 * 00:00:00 UTC means "this day, no specific time" — which is how Pipedrive
 * date-only activities import (and why ~1,800 of them rendered as 5pm PT).
 * All-day items belong on their UTC date and show no clock time.
 */

export function isAllDayIso(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
}

/** "YYYY-MM-DD" → the canonical all-day ISO for that date. */
export function allDayIso(dateStr: string): string {
  return `${dateStr}T00:00:00.000Z`;
}

/** The day an activity belongs on: UTC date for all-day, local date otherwise. */
export function activityDayKey(iso: string): string {
  if (isAllDayIso(iso)) return iso.slice(0, 10);
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Split a stored due_at into date + time inputs (time empty = all-day). */
export function splitDue(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  if (isAllDayIso(iso)) return { date: iso.slice(0, 10), time: "" };
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

/** A TIMED instant that must never read as all-day: 5:00 PM PDT (4:00 PM
 * PST) is exactly 00:00Z — the all-day sentinel — which silently turned a
 * rep's chosen time into an all-day entry (Kyle 9/9). Nudge by 30s; every
 * display shows hours:minutes so it's invisible. */
export function timedIso(d: Date): string {
  const iso = d.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? new Date(d.getTime() + 30_000).toISOString() : iso;
}

/** Combine a date + optional local time into a stored ISO (empty time = all-day). */
export function combineDue(date: string, time: string): string | null {
  if (!date) return null;
  return time ? timedIso(new Date(`${date}T${time}`)) : allDayIso(date);
}
