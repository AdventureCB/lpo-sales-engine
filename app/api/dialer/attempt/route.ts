import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Record a dial attempt the moment the rep hits Dial. Drives the shared
 * pool's 2-day cooldown and round-fairness (and is useful attempt data for
 * every queue).
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { dealId?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.dealId) return NextResponse.json({ error: "dealId required" }, { status: 400 });

  const { error } = await supabaseAdmin().from("dial_attempts").insert({
    deal_id: body.dealId,
    actor: user.email,
    rep_id: user.repId,
  });
  if (error) {
    console.error("attempt insert failed", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
