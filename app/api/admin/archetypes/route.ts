import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Archetype + universal-attribute taxonomy (admin). The editable vocabulary
 * the AI deal-profiler classifies against. GET returns both catalogs; POST
 * upserts or deletes one row of either.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  const [{ data: archetypes }, { data: attributes }] = await Promise.all([
    db.from("deal_archetypes").select("*").order("sort_order"),
    db.from("profile_attributes").select("*").order("sort_order"),
  ]);
  return NextResponse.json({ archetypes: archetypes ?? [], attributes: attributes ?? [] });
}

const ARCHETYPE_COLS = new Set([
  "key", "name", "emoji", "tagline", "description",
  "positive_traits", "negative_traits", "signals", "ad_ids", "selling_approach", "avoid",
  "sort_order", "enabled",
]);
const ATTRIBUTE_COLS = new Set([
  "key", "name", "description", "category", "value_type", "options", "sort_order", "enabled",
]);

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || `item_${Date.now()}`;
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { entity, op, data } = body ?? {};
  if (entity !== "archetype" && entity !== "attribute")
    return NextResponse.json({ error: "entity must be archetype|attribute" }, { status: 400 });
  const table = entity === "archetype" ? "deal_archetypes" : "profile_attributes";
  const allowed = entity === "archetype" ? ARCHETYPE_COLS : ATTRIBUTE_COLS;
  const db = supabaseAdmin();

  if (op === "delete") {
    if (!data?.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const { error } = await db.from(table).delete().eq("id", data.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (op === "upsert") {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data ?? {})) if (allowed.has(k)) row[k] = v;
    if (!row.name) return NextResponse.json({ error: "name required" }, { status: 400 });
    row.updated_at = new Date().toISOString();

    if (data?.id) {
      const { error } = await db.from(table).update(row).eq("id", data.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, id: data.id });
    }
    // New row — derive a stable key from the name if not supplied.
    if (!row.key) row.key = slugify(String(row.name));
    const { data: created, error } = await db.from(table).insert(row).select("id").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: created?.id });
  }

  return NextResponse.json({ error: "op must be upsert|delete" }, { status: 400 });
}
