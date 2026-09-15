import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Review-dashboard data. Returns 90 days of scorecard rows (trimmed to what
 * the dashboard aggregates: verdicts + snapshot + deal link) plus the rep's
 * qualitative patterns. Reps get their own; admins get everyone's (the view
 * builds the group comparison client-side).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const isAdmin = user.role === "admin";

  let repName: string | null = user.repName;
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();

  let q = db
    .from("call_reviews")
    .select("id, rep, created_at, deal_id, quo_call_id, review, excluded_from_score, crm_deals ( id, title )")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (!isAdmin) {
    if (!repName) return NextResponse.json({ reviews: [], patterns: null, me: null, rank: [], volume: [] });
    q = q.eq("rep", repName);
  }

  // Team leaderboard rows for EVERY user: rep + when + computed score only
  // (peers see each other's numbers, never each other's call contents).
  const { data: rankRaw } = await db
    .from("call_reviews")
    .select("rep, created_at, review, excluded_from_score")
    .gte("created_at", since)
    .not("rep", "is", null)
    .limit(2000);
  const VS: Record<string, number> = { hit: 1, partial: 0.5, missed: 0 };
  // Excluded reviews (policy or admin) don't feed the KPI/leaderboard.
  const rank = (rankRaw ?? []).filter((r: any) => !r.excluded_from_score).map((r: any) => {
    const sc = (r.review?.scorecard ?? []) as { verdict: string }[];
    const score = sc.length === 5 ? sc.reduce((a, x) => a + (VS[x.verdict] ?? 0), 0) : null;
    return { rep: r.rep as string, at: r.created_at as string, score };
  });
  const [{ data: rows }, { data: patterns }, { data: volRows }] = await Promise.all([
    q,
    isAdmin ? db.from("rep_call_patterns").select("*") : db.from("rep_call_patterns").select("*").eq("rep", repName ?? ""),
    // Everyone gets the whole team's review timestamps (rep + at only) — the
    // volume curve grades each rep against the period leader's count, so a
    // rep needs to see where the bar is even though they only see their own
    // review contents.
    db.from("call_reviews").select("rep, created_at, excluded_from_score").gte("created_at", since).not("rep", "is", null).limit(2000),
  ]);

  const reviews = (rows ?? []).map((r: any) => ({
    id: r.id,
    rep: r.rep,
    at: r.created_at,
    dealId: (r.crm_deals as any)?.id ?? r.deal_id,
    dealTitle: (r.crm_deals as any)?.title ?? null,
    snapshot: r.review?.snapshot ?? null,
    scorecard: (r.review?.scorecard ?? []).map((s: any) => ({ principle: s.principle, verdict: s.verdict })),
    thin: !!r.review?.thin_transcript,
    excluded: !!r.excluded_from_score,
  }));

  const volume = (volRows ?? []).filter((v: any) => !v.excluded_from_score).map((v: any) => ({ rep: v.rep as string, at: v.created_at as string }));
  return NextResponse.json({ reviews, patterns: patterns ?? [], me: repName, isAdmin, volume, rank });
}

/** Admin: include/exclude one review from the score (marks excluded_by=email). */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { id?: string; excluded?: boolean };
  try {
    body = await (req as any).json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabaseAdmin()
    .from("call_reviews")
    .update({ excluded_from_score: !!body.excluded, excluded_by: user.email })
    .eq("id", body.id);
  return NextResponse.json({ ok: !error });
}
