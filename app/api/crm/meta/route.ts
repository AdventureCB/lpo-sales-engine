import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pipelines, stages, and mirror freshness for the CRM UI. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const [pipelines, stages, dealCount, contactCount, importState] = await Promise.all([
    db.from("crm_pipelines").select("id, name, sort_order").order("sort_order"),
    db.from("crm_stages").select("id, pipeline_id, name, sort_order").order("sort_order"),
    db.from("crm_deals").select("id", { count: "exact", head: true }),
    db.from("crm_contacts").select("id", { count: "exact", head: true }),
    db.from("crm_sync_state").select("value, updated_at").eq("key", "import").maybeSingle(),
  ]);

  return NextResponse.json({
    pipelines: pipelines.data ?? [],
    stages: stages.data ?? [],
    mirror: {
      deals: dealCount.count ?? 0,
      contacts: contactCount.count ?? 0,
      importState: importState.data?.value ?? null,
      importUpdatedAt: importState.data?.updated_at ?? null,
    },
  });
}
