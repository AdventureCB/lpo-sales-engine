import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List sprints (admin: all; sales: their own) with progress. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  let q = db
    .from("crm_sprints")
    .select("id, name, owner, status, created_at, crm_sprint_items ( deal_id, called_at )")
    .neq("status", "archived")
    .order("created_at", { ascending: false });
  if (user.role !== "admin") q = q.eq("owner", user.email);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  const sprints = (data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    owner: s.owner,
    status: s.status,
    created_at: s.created_at,
    total: (s.crm_sprint_items ?? []).length,
    called: (s.crm_sprint_items ?? []).filter((i: any) => i.called_at).length,
  }));
  return NextResponse.json({ sprints });
}

/** Create a sprint from selected deals. Admins pick the owner; sales reps
 * always create for themselves. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { name?: string; owner?: string; dealIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const name = body.name?.trim();
  const owner = user.role === "admin" ? body.owner?.trim() : user.email;
  const dealIds = body.dealIds ?? [];
  if (!name || !owner || dealIds.length === 0 || dealIds.length > 500) {
    return NextResponse.json({ error: "name, owner, 1-500 dealIds required" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: sprint, error } = await db
    .from("crm_sprints")
    .insert({ name, owner })
    .select("id")
    .single();
  if (error || !sprint) return NextResponse.json({ error: "db error" }, { status: 500 });

  const items = dealIds.map((dealId, i) => ({ sprint_id: sprint.id, deal_id: dealId, position: i }));
  const { error: e2 } = await db.from("crm_sprint_items").insert(items);
  if (e2) return NextResponse.json({ error: "db error" }, { status: 500 });

  return NextResponse.json({ ok: true, sprintId: sprint.id });
}

/** Archive / complete a sprint. */
export async function PATCH(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { id?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.id || !["done", "archived", "active"].includes(body.status ?? "")) {
    return NextResponse.json({ error: "id and valid status required" }, { status: 400 });
  }
  const db = supabaseAdmin();
  let q = db.from("crm_sprints").update({ status: body.status }).eq("id", body.id);
  if (user.role !== "admin") q = q.eq("owner", user.email);
  const { error } = await q;
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
