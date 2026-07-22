import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { cachedQueueLeads, type OwnerScope } from "@/lib/dialer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Queue list with live counts for the current user's ownership scope. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const owner = (new URL(req.url).searchParams.get("owner") ?? "both") as OwnerScope;

  const db = supabaseAdmin();
  const { data: queues, error } = await db
    .from("queue_config")
    .select("id, name, stage_ids, priority, cadence_days, is_primary, pool_mode")
    .order("priority");
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  const out = [];
  for (const q of queues ?? []) {
    try {
      const { leads, pool } = await cachedQueueLeads({
        user,
        stageIds: q.stage_ids,
        ownerScope: owner,
        poolMode: q.pool_mode ?? false,
        takeLeases: false, // counts must not reserve leads
        cacheKey: q.id,
      });
      out.push({ ...q, count: pool ? pool.eligible : leads.length });
    } catch (e) {
      console.error(`queue count failed for ${q.name}`, e);
      out.push({ ...q, count: null });
    }
  }
  return NextResponse.json({ queues: out });
}
