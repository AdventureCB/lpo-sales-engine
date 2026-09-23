import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VS: Record<string, number> = { hit: 1, partial: 0.5, missed: 0 };
const scoreOf = (review: any): number | null => {
  const sc = (review?.scorecard ?? []) as { verdict: string }[];
  return sc.length === 5 ? sc.reduce((a, x) => a + (VS[x.verdict] ?? 0), 0) : null;
};

/** One call review in full (scorecard notes, history, overrides) — admin, or the rep it belongs to. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { data: r } = await supabaseAdmin()
    .from("call_reviews")
    .select("id, rep, deal_id, activity_id, quo_call_id, review, history, bonus, bonus_by, excluded_from_score, excluded_by, created_at, updated_at, model, transcript_chars, crm_deals ( id, title )")
    .eq("id", id)
    .maybeSingle();
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (user.role !== "admin" && r.rep !== user.repName) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const history = (Array.isArray(r.history) ? r.history : []) as any[];
  return NextResponse.json({
    id: r.id,
    rep: r.rep,
    at: r.created_at,
    updatedAt: r.updated_at,
    reReviewed: Date.parse(r.updated_at) - Date.parse(r.created_at) > 120_000,
    deal: (r.crm_deals as any) ?? (r.deal_id ? { id: r.deal_id, title: null } : null),
    review: r.review,
    score: scoreOf(r.review),
    overrides: r.review?.overrides ?? [],
    history: history.map((h) => ({ at: h.updated_at ?? null, reason: h.reason ?? "earlier version", score: scoreOf(h.review), model: h.model ?? null })),
    bonus: r.bonus ?? 0,
    bonusBy: r.bonus_by,
    excluded: !!r.excluded_from_score,
    excludedBy: r.excluded_by,
    model: r.model,
    transcriptChars: r.transcript_chars,
  });
}
