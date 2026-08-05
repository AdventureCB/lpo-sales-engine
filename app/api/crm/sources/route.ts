import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deal sources: read = everyone; manage = admin. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const { data } = await db
    .from("deal_sources")
    .select("id, name, pipedrive_channel_id, sort_order")
    .order("sort_order")
    .order("name");
  return NextResponse.json({ sources: data ?? [] });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  let body: {
    op?: "save" | "delete";
    source?: { id?: string; name?: string; pipedriveChannelId?: number | null };
    id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();

  if (body.op === "save") {
    const s = body.source;
    if (!s?.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
    const row: Record<string, unknown> = { name: s.name.trim() };
    if (s.pipedriveChannelId !== undefined) row.pipedrive_channel_id = s.pipedriveChannelId;
    const q = s.id ? db.from("deal_sources").update(row).eq("id", s.id) : db.from("deal_sources").insert(row);
    const { error } = await q;
    if (error) {
      return NextResponse.json(
        { error: /duplicate/i.test(error.message) ? "a source with that name exists" : "db error" },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true });
  }
  if (body.op === "delete" && body.id) {
    // Deals pointing at it fall back to no source.
    await db.from("crm_deals").update({ source_id: null }).eq("source_id", body.id);
    await db.from("deal_sources").delete().eq("id", body.id);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}
