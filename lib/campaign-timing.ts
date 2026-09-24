import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Send-time optimization (Phase 3). Pick the hour a specific buyer actually
 * opens email, from their history: Klaviyo opens (engagement_events
 * email_open) + our own pixel (email_tracking). Under 5 opens → a prior
 * curve. Always inside the campaign's contact-local window, never on a
 * weekend, with minute jitter so sends don't all land at :00.
 */

const H = 3_600_000;
// Local-hour prior when we know little about the person: mid-morning and
// early afternoon, tapering at the edges of a work day.
const PRIOR: Record<number, number> = { 7: 0.4, 8: 0.7, 9: 1, 10: 0.95, 11: 0.7, 12: 0.5, 13: 0.7, 14: 0.85, 15: 0.75, 16: 0.55, 17: 0.4, 18: 0.3 };

export interface SendSlot { at: number; hour: number; basis: "contact" | "prior"; opens: number }

export async function bestSendTime(
  db: SupabaseClient,
  args: { emails: string[]; tzOffset: number | null; window: { start: number; end: number }; notBefore: number }
): Promise<SendSlot> {
  const off = args.tzOffset ?? -7;
  const hist = new Array<number>(24).fill(0);
  let opens = 0;
  if (args.emails.length) {
    const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
    const [{ data: ev }, { data: tr }] = await Promise.all([
      db.from("engagement_events").select("occurred_at").eq("type", "email_open").in("person_email", args.emails).gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(400),
      db.from("email_tracking").select("first_open_at, last_open_at").in("to_email", args.emails).not("first_open_at", "is", null).limit(100),
    ]);
    const stamp = (iso: string | null) => {
      if (!iso) return;
      const local = new Date(Date.parse(iso) + off * H);
      hist[local.getUTCHours()]++;
      opens++;
    };
    for (const e of ev ?? []) stamp(e.occurred_at);
    for (const t of tr ?? []) { stamp(t.first_open_at); if (t.last_open_at && t.last_open_at !== t.first_open_at) stamp(t.last_open_at); }
  }

  // Score each hour in the window: smoothed personal histogram, or the prior.
  const basis: SendSlot["basis"] = opens >= 5 ? "contact" : "prior";
  let bestHour = args.window.start;
  let bestScore = -1;
  for (let h = args.window.start; h < args.window.end; h++) {
    const score = basis === "contact" ? hist[h] + 0.5 * (hist[(h + 23) % 24] + hist[(h + 1) % 24]) : PRIOR[h] ?? 0.2;
    if (score > bestScore) { bestScore = score; bestHour = h; }
  }

  // Next weekday occurrence of that local hour at/after notBefore.
  const jitterMin = 3 + Math.floor(Math.random() * 45);
  let at = 0;
  const startLocal = new Date(args.notBefore + off * H);
  for (let dayAdd = 0; dayAdd < 10; dayAdd++) {
    const d = new Date(Date.UTC(startLocal.getUTCFullYear(), startLocal.getUTCMonth(), startLocal.getUTCDate() + dayAdd, bestHour, jitterMin));
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // no weekend sends
    const utc = d.getTime() - off * H;
    if (utc >= args.notBefore) { at = utc; break; }
    // Same day but the hour has passed: any later hour still inside the window today beats waiting a day.
    if (dayAdd === 0) {
      const nowLocalHour = startLocal.getUTCHours() + startLocal.getUTCMinutes() / 60;
      if (nowLocalHour < args.window.end - 0.25 && nowLocalHour >= args.window.start) {
        at = args.notBefore + 5 * 60_000;
        break;
      }
    }
  }
  if (!at) at = args.notBefore;
  return { at, hour: bestHour, basis, opens };
}
