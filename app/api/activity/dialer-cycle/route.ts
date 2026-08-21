import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CAP_MS = 30 * 60_000; // beyond 30min the rep clearly walked away — not signal

/** One dialer cycle's micro-timings (see migration 00106). Fire-and-forget. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { crmDealId?: string; viewMs?: number; wrapMs?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const clamp = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= CAP_MS ? Math.round(n) : null;
  };
  const view_ms = clamp(body.viewMs);
  const wrap_ms = clamp(body.wrapMs);
  if (view_ms == null && wrap_ms == null) return NextResponse.json({ ok: true, skipped: true });
  await supabaseAdmin().from("dialer_cycle_stats").insert({
    rep_email: user.email,
    crm_deal_id: body.crmDealId ?? null,
    view_ms,
    wrap_ms,
  });
  return NextResponse.json({ ok: true });
}
