import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Engagement history for one deal — powers the expandable hot-list rows. */
export async function GET(req: NextRequest) {
  const dealId = Number(new URL(req.url).searchParams.get("dealId"));
  if (!Number.isFinite(dealId)) {
    return NextResponse.json({ error: "dealId required" }, { status: 400 });
  }
  const db = supabaseAdmin();
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
