import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { computeEngagement, laToday } from "@/lib/engagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * PUBLIC (any logged-in user) engagement slices for today — powers the
 * scoreboard's per-rep "where the day went" pies ("no secrets", Kyle 9/10).
 * computeEngagement is a multi-query pass, and the scoreboard TV polls, so
 * responses are cached per warm instance for 2 minutes.
 */
const cache = new Map<string, { at: number; body: unknown }>();

function laDateDaysAgo(n: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(Date.now() - n * 86_400_000));
}

type Trimmed = {
  name: string; engagedS: number; talkingS: number; inboundTalkS: number; dialingS: number;
  idleS: number; betweenS: number; otherS: number;
  surfaces: Record<string, number>; tools: Record<string, number>;
};

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const range = params.get("range");
  const dateParam = params.get("date");

  // Resolve the day list: ?range=week = Monday..today; ?date=YYYY-MM-DD =
  // that day; default = YESTERDAY (a finished day reads better on the wall
  // than a half-built one).
  let dates: string[];
  if (range === "week") {
    const out: string[] = [];
    for (let n = 6; n >= 0; n--) {
      const d = laDateDaysAgo(n);
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      out.push(d);
      void dow;
    }
    // keep from most recent Monday
    const mondayIdx = out.findIndex((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 1);
    dates = mondayIdx >= 0 ? out.slice(mondayIdx) : out;
  } else if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) && dateParam <= laToday()) {
    dates = [dateParam];
  } else {
    dates = [laDateDaysAgo(1)];
  }
  const key = dates.join(",");
  const hit = cache.get(key);
  // Finished (past) days never change — cache them long; today refreshes.
  const ttl = dates.includes(laToday()) ? 120_000 : 3_600_000;
  if (hit && Date.now() - hit.at < ttl) return NextResponse.json(hit.body);

  const db = supabaseAdmin();
  const merged = new Map<string, Trimmed>();
  for (const d of dates) {
    const reps = await computeEngagement(db, d);
    for (const r of reps) {
      const cur =
        merged.get(r.name) ??
        ({ name: r.name, engagedS: 0, talkingS: 0, inboundTalkS: 0, dialingS: 0, idleS: 0, betweenS: 0, otherS: 0, surfaces: {}, tools: {} } as Trimmed);
      cur.engagedS += (r as any).engagedS ?? 0;
      cur.talkingS += r.talkingS;
      cur.inboundTalkS += r.inboundTalkS;
      cur.dialingS += r.dialingS;
      cur.idleS += r.idleS;
      cur.betweenS += r.betweenS;
      cur.otherS += r.otherS;
      for (const [k, v] of Object.entries(r.surfaces ?? {})) cur.surfaces[k] = (cur.surfaces[k] ?? 0) + v;
      for (const [k, v] of Object.entries(((r as any).tools ?? {}) as Record<string, number>)) cur.tools[k] = (cur.tools[k] ?? 0) + v;
      merged.set(r.name, cur);
    }
  }
  const { data: toolCfg } = await db.from("crm_sync_state").select("value").eq("key", "tool_links").maybeSingle();
  const toolLabels: Record<string, { label: string; emoji: string }> = {};
  for (const t of ((toolCfg?.value as any)?.tools ?? []) as { key: string; label: string; emoji: string }[]) {
    if (t.key && t.label) toolLabels[t.key] = { label: t.label, emoji: t.emoji ?? "🧰" };
  }
  const body = { dates, toolLabels, reps: [...merged.values()] };
  if (cache.size > 20) cache.clear();
  cache.set(key, { at: Date.now(), body });
  return NextResponse.json(body);
}
