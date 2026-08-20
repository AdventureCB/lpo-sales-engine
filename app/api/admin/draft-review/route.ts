import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { runDraftReview, decideDraftProposal } from "@/lib/ai-draft-critic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Draft & theme review — run the critic, list proposals, decide. Admin. */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const [{ data: pending }, { data: recent }, { count: drafts60d }, { data: rules }] = await Promise.all([
    db.from("draft_proposals").select("*").eq("status", "pending").order("created_at", { ascending: false }).limit(30),
    db.from("draft_proposals").select("kind, target_key, status, decided_by, decided_at, rationale").neq("status", "pending").order("decided_at", { ascending: false }).limit(10),
    db.from("draft_events").select("id", { count: "exact", head: true }).gte("generated_at", since),
    db.from("draft_style_rules").select("id, channel, rule, enabled, created_at").order("created_at", { ascending: false }),
  ]);
  return NextResponse.json({ pending: pending ?? [], recent: recent ?? [], drafts60d: drafts60d ?? 0, rules: rules ?? [] });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { action?: "run" | "decide"; id?: string; approve?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();
  if (body.action === "run") {
    const result = await runDraftReview(db);
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 422 });
    return NextResponse.json(result);
  }
  if (body.action === "decide" && body.id) {
    const result = await decideDraftProposal(db, body.id, body.approve === true, user.email);
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
