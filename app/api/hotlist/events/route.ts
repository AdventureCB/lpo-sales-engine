import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Engagement history for one deal — powers the expandable hot-list rows. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dealId = Number(new URL(req.url).searchParams.get("dealId"));
  if (!Number.isFinite(dealId)) {
    return NextResponse.json({ error: "dealId required" }, { status: 400 });
  }
  const db = supabaseAdmin();
  if (user.role === "sales") {
    const { data: flag } = await db
      .from("hot_flags")
      .select("owner_pipedrive_id")
      .eq("deal_id", dealId)
      .order("flagged_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (flag?.owner_pipedrive_id !== user.pipedriveUserId) {
      return NextResponse.json({ error: "not your deal" }, { status: 403 });
    }
  }
  const { data, error } = await db
    .from("engagement_events")
    .select("source, type, person_email, occurred_at, meta")
    .eq("pipedrive_deal_id", dealId)
    .order("occurred_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error("deal events query failed", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }
  return NextResponse.json({ events: data ?? [] });
}
