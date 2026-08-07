import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { loadConfig } from "@/lib/sprint-lists";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read the tunable Sprint List config (admin only). */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const cfg = await loadConfig(supabaseAdmin());
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
  const db = supabaseAdmin();
  const current = await loadConfig(db);
  const merged = {
    ...current,
    ...patch,
    windows: { ...current.windows, ...(patch.windows ?? {}) },
    clock: { ...current.clock, ...(patch.clock ?? {}) },
  };
  const { error } = await db
    .from("sprint_list_config")
    .upsert({ id: true, config: merged, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ ok: true, config: merged });
}
