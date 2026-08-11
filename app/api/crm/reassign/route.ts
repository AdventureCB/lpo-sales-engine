import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { loadReassignConfig, saveReassignConfig, sweepInactiveDeals } from "@/lib/reassign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Auto-reassignment config (admin). ?preview=1 dry-runs the sweep. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  const cfg = await loadReassignConfig(db);
  if (req.nextUrl.searchParams.get("preview") === "1") {
    const res = await sweepInactiveDeals(db, cfg, { dryRun: true });
    return NextResponse.json({ config: cfg, matched: res.matched, capped: res.capped, sample: res.candidates.slice(0, 15) });
  }
  return NextResponse.json({ config: cfg });
}

/** Merge-update the config (admin only). Body = partial config. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let patch: any;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const merged = await saveReassignConfig(supabaseAdmin(), patch);
  return NextResponse.json({ ok: true, config: merged });
}
