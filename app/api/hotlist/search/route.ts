import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Search everyone who has EVER been on the hot list (active, cooled-down,
 * or cleared) by deal title. Sales users search only their own deals.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const term = (new URL(req.url).searchParams.get("term") ?? "").trim();
  if (term.length < 2) return NextResponse.json({ results: [] });

  const db = supabaseAdmin();
  let q = db
    .from("hot_flags")
    .select("id, deal_id, reason, deal_title, owner_name, person_phone, flagged_at, cleared_at, cooldown_until")
    .ilike("deal_title", `%${term.replace(/[%_]/g, "")}%`)
    .order("flagged_at", { ascending: false })
    .limit(30);
  if (user.role === "sales") q = q.eq("owner_pipedrive_id", user.pipedriveUserId);

  const { data, error } = await q;
  if (error) {
    console.error("hot search failed", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }
  return NextResponse.json({ results: data ?? [] });
}
