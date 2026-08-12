import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { isAuthorizedCron } from "@/lib/cron";
import { extractProfile } from "@/lib/ai-profiler-engine";
import { monthToDateSpendCents } from "@/lib/ai-profiler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Read the stored profile for a deal (admin). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dealId = req.nextUrl.searchParams.get("dealId");
  if (!dealId) return NextResponse.json({ error: "dealId required" }, { status: 400 });
  const db = supabaseAdmin();
  const { data } = await db.from("deal_profiles").select("*").eq("deal_id", dealId).maybeSingle();
  return NextResponse.json({ profile: data ?? null });
}

/**
 * Build / refresh a deal's profile. Admin (deal-page button) or cron
 * (batch/lazy refresh). `force` bypasses scope+debounce+budget for a manual
 * run; `tier` overrides the model (the deep-dive path).
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  const admin = user?.role === "admin";
  if (!admin && !isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 403 });

  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const dealId = body.dealId ?? req.nextUrl.searchParams.get("dealId");
  if (!dealId) return NextResponse.json({ error: "dealId required" }, { status: 400 });

  const db = supabaseAdmin();
  const outcome = await extractProfile(db, dealId, { force: body.force === true, tier: body.tier });
  const spentCents = await monthToDateSpendCents(db);
  return NextResponse.json({ ...outcome, monthToDateSpend: `$${(spentCents / 100).toFixed(2)}` });
}
