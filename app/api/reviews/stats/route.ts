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
    .select("id, rep, created_at, deal_id, quo_call_id, review, crm_deals ( id, title )")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (!isAdmin) {
    if (!repName) return NextResponse.json({ reviews: [], patterns: null, me: null });
    q = q.eq("rep", repName);
  }
  const [{ data: rows }, { data: patterns }, { data: volRows }] = await Promise.all([
    q,
    isAdmin ? db.from("rep_call_patterns").select("*") : db.from("rep_call_patterns").select("*").eq("rep", repName ?? ""),
    // Everyone gets the whole team's review timestamps (rep + at only) — the
    // volume curve grades each rep against the period leader's count, so a
    // rep needs to see where the bar is even though they only see their own
    // review contents.
    db.from("call_reviews").select("rep, created_at").gte("created_at", since).not("rep", "is", null).limit(2000),
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
  }));

  const volume = (volRows ?? []).map((v: any) => ({ rep: v.rep as string, at: v.created_at as string }));
  return NextResponse.json({ reviews, patterns: patterns ?? [], me: repName, isAdmin, volume });
}
