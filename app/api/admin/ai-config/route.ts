import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { loadAiConfig, saveAiConfig, monthToDateSpendCents } from "@/lib/ai-profiler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** AI profiler config + live spend + the pipeline list for scope (admin). */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  const [config, spentCents, { data: pipelines }, { data: profiled }] = await Promise.all([
    loadAiConfig(db),
    monthToDateSpendCents(db),
    db.from("crm_pipelines").select("name").order("sort_order"),
    db.from("deal_profiles").select("deal_id", { count: "exact", head: true }),
  ]);
  return NextResponse.json({
    config,
    monthToDateSpendCents: spentCents,
    pipelines: (pipelines ?? []).map((p) => p.name),
    profiledCount: (profiled as any)?.count ?? null,
  });
}

/** Merge-update config (admin). */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let patch: any;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const merged = await saveAiConfig(supabaseAdmin(), patch);
  return NextResponse.json({ ok: true, config: merged });
}
