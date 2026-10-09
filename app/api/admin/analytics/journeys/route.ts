import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { loadJourneys, summarizeJourneys } from "@/lib/journey-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Journey patterns for deals created in a window: ?days=90 (or start/end), ?won=1 restricts to won deals, ?source=<deal source name>. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const p = new URL(req.url).searchParams;
  const days = Math.min(730, Math.max(7, Number(p.get("days")) || 90));
  const end = p.get("end") ? `${p.get("end")}T23:59:59.999Z` : new Date().toISOString();
  const start = p.get("start") ? `${p.get("start")}T00:00:00Z` : new Date(Date.parse(end) - days * 86_400_000).toISOString();
  const db = supabaseAdmin();
  try {
    const all = await loadJourneys(db, start, end);
    const sources = [...new Set(all.map((j) => j.sourceName).filter(Boolean) as string[])].sort();
    let js = all;
    if (p.get("won") === "1") js = js.filter((j) => j.status === "won");
    const source = p.get("source");
    if (source) js = js.filter((j) => (j.sourceName ?? "").toLowerCase() === source.toLowerCase());
    const minSteps = Number(p.get("minSteps")) || 1;
    if (minSteps > 1) js = js.filter((j) => j.steps.length >= minSteps);
    return NextResponse.json({ start: start.slice(0, 10), end: end.slice(0, 10), sources, ...summarizeJourneys(js) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
