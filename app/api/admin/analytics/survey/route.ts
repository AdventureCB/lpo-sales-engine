import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Build Survey funnel analytics (survey_funnel RPC, migration 00189).
 *   GET ?days=30 | start&end, device, version, truck=truck|no_truck, source, test=1
 *   GET ?run=<run_id>  → that run's event timeline + the deal its submission created
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const p = new URL(req.url).searchParams;
  const db = supabaseAdmin();

  const run = p.get("run");
  if (run) {
    const { data: events } = await db.from("survey_events").select("at, name, step, step_index, ms, answer, data, test").eq("run_id", run).order("at").order("id").limit(1000);
    const { data: r } = await db.from("survey_runs").select("*").eq("run_id", run).maybeSingle();
    let deal: { id: string; title: string } | null = null;
    if (r?.submission_id) {
      // The web-form webhook uses submission_id as the intake external id.
      const { data: ie } = await db.from("intake_events").select("deal_id, crm_deals ( id, title )").eq("external_id", r.submission_id).not("deal_id", "is", null).limit(1).maybeSingle();
      const d = (ie as any)?.crm_deals;
      if (d) deal = { id: d.id, title: d.title };
    }
    return NextResponse.json({ run: r, events: events ?? [], deal });
  }

  const days = Math.min(730, Math.max(1, Number(p.get("days")) || 30));
  const end = p.get("end") ? `${p.get("end")}T23:59:59.999Z` : new Date().toISOString();
  const start = p.get("start") ? `${p.get("start")}T00:00:00Z` : new Date(Date.parse(end) - days * 86_400_000).toISOString();
  const opt = (k: string) => p.get(k)?.trim() || null;
  const { data, error } = await db.rpc("survey_funnel", {
    p_from: start, p_to: end, p_form: "build-survey",
    p_device: opt("device"), p_version: opt("version"), p_truck: opt("truck"), p_source: opt("source"), p_test: p.get("test") === "1",
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ start: start.slice(0, 10), end: end.slice(0, 10), ...(data as object) });
}
