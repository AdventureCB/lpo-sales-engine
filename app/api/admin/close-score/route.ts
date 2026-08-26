import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { dealCloseScore } from "@/lib/ai-hypotheses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin-only: indicative close-likelihood for a deal (hypothesis-driven). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const dealId = new URL(req.url).searchParams.get("dealId");
  if (!dealId) return NextResponse.json({ error: "dealId required" }, { status: 400 });
  const score = await dealCloseScore(supabaseAdmin(), dealId);
  if (!score) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(score);
}
