import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { suggestThemes } from "@/lib/ai-scripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Enabled draft themes, ranked for this deal (zero-token heuristic). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dealId = req.nextUrl.searchParams.get("dealId");
  if (!dealId) return NextResponse.json({ error: "dealId required" }, { status: 400 });
  const themes = await suggestThemes(supabaseAdmin(), dealId);
  return NextResponse.json({ themes });
}
