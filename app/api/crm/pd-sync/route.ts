import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { processPdSyncQueue } from "@/lib/pd-sync";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Pending-count for the CRM header badge. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  const { count } = await db
    .from("pd_sync_queue")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");
  return NextResponse.json({ pending: count ?? 0 });
}

/** Manual "sync Pipedrive now" trigger (admin). */
export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const result = await processPdSyncQueue(supabaseAdmin(), 40_000);
  return NextResponse.json({ ok: true, ...result });
}
