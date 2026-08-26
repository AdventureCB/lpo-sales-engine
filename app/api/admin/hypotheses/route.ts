import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { runHypothesisGeneration, scoreProspective, buildFeatureChunk } from "@/lib/ai-hypotheses";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Admin: the hypothesis ledger + its controls. */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  const [{ data: hyps }, { count: featN }, { data: latest }] = await Promise.all([
    db.from("ai_hypotheses").select("*").order("created_at", { ascending: false }).limit(200),
    db.from("ai_deal_features").select("deal_id", { count: "exact", head: true }),
    db.from("ai_deal_features").select("computed_at").order("computed_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return NextResponse.json({ hypotheses: hyps ?? [], snapshot: { deals: featN ?? 0, at: latest?.computed_at ?? null } });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  let body: { op?: string; id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (body.op === "generate") {
    const r = await runHypothesisGeneration(db);
    return NextResponse.json({ ok: true, ...r });
  }
  if (body.op === "score") {
    const { count } = await db.from("ai_deal_features").select("deal_id", { count: "exact", head: true });
    await buildFeatureChunk(db, Math.max(0, (count ?? 0) - 20));
    const r = await scoreProspective(db);
    return NextResponse.json({ ok: true, ...r });
  }
  if ((body.op === "approve" || body.op === "unapprove" || body.op === "retire") && body.id) {
    const patch =
      body.op === "retire"
        ? { status: "retired", retired_at: new Date().toISOString(), retire_reason: "manually retired" }
        : { human_approved: body.op === "approve" };
    const { error } = await db.from("ai_hypotheses").update(patch).eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}
