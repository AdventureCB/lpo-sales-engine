import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

/** Record a session skip (main Skip button or up-next ✕). */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { dealId?: number; dealTitle?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.dealId) return NextResponse.json({ error: "dealId required" }, { status: 400 });

  const { error } = await supabaseAdmin().from("dial_skips").insert({
    actor: user.email,
    rep_id: user.repId,
    deal_id: body.dealId,
    deal_title: body.dealTitle ?? null,
  });
  if (error) {
    console.error("skip insert failed", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
