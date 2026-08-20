import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { runRepPatterns } from "@/lib/ai-call-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Per-rep coaching patterns synthesized from stored call reviews. */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const [{ data: patterns }, { data: reviews }] = await Promise.all([
    db.from("rep_call_patterns").select("*").order("rep"),
    db.from("call_reviews").select("rep").gte("created_at", since).limit(1000),
  ]);
  const counts: Record<string, number> = {};
  for (const r of reviews ?? []) {
    if (r.rep) counts[r.rep] = (counts[r.rep] ?? 0) + 1;
  }
  return NextResponse.json({ patterns: patterns ?? [], counts, totalReviews90d: (reviews ?? []).length });
}

/** Run (or re-run) the synthesis — manual button, one model call per rep. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { windowDays?: number } = {};
  try {
    body = await req.json();
  } catch {}
  const results = await runRepPatterns(supabaseAdmin(), { windowDays: body.windowDays });
  return NextResponse.json({ ok: true, results });
}
