import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { runTaxonomyReview, decideProposal } from "@/lib/ai-taxonomy-critic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Taxonomy review: run the critic, list proposals, decide them. Admin only. */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  const [{ data: pending }, { data: recent }, { count: everRun }] = await Promise.all([
    db.from("taxonomy_proposals").select("*").eq("status", "pending").order("created_at", { ascending: false }).limit(30),
    db.from("taxonomy_proposals").select("kind, target_key, status, decided_by, decided_at, rationale").neq("status", "pending").order("decided_at", { ascending: false }).limit(10),
    db.from("taxonomy_proposals").select("id", { count: "exact", head: true }),
  ]);
  return NextResponse.json({ pending: pending ?? [], recent: recent ?? [], everRun: (everRun ?? 0) > 0 });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { action?: "run" | "decide"; bootstrap?: boolean; id?: string; approve?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();

  if (body.action === "run") {
    const result = await runTaxonomyReview(db, { bootstrap: body.bootstrap === true });
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 422 });
    return NextResponse.json(result);
  }
  if (body.action === "decide" && body.id) {
    const result = await decideProposal(db, body.id, body.approve === true, user.email);
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
