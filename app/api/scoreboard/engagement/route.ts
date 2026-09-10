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
let cache: { at: number; body: unknown } | null = null;

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (cache && Date.now() - cache.at < 120_000) return NextResponse.json(cache.body);

  const db = supabaseAdmin();
  const reps = await computeEngagement(db, laToday());
  const { data: toolCfg } = await db.from("crm_sync_state").select("value").eq("key", "tool_links").maybeSingle();
  const toolLabels: Record<string, { label: string; emoji: string }> = {};
  for (const t of ((toolCfg?.value as any)?.tools ?? []) as { key: string; label: string; emoji: string }[]) {
    if (t.key && t.label) toolLabels[t.key] = { label: t.label, emoji: t.emoji ?? "🧰" };
  }
  const body = {
    date: laToday(),
    toolLabels,
    reps: reps.map((r) => ({
      name: r.name,
      engagedS: (r as any).engagedS ?? 0,
      talkingS: r.talkingS,
      inboundTalkS: r.inboundTalkS,
      dialingS: r.dialingS,
      idleS: r.idleS,
      betweenS: r.betweenS,
      otherS: r.otherS,
      surfaces: r.surfaces,
      tools: (r as any).tools ?? {},
    })),
  };
  cache = { at: Date.now(), body };
  return NextResponse.json(body);
}
