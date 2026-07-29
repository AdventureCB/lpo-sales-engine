import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import type { OwnerScope } from "@/lib/dialer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Queue list with counts served from the last real build (queue_counts) —
 * zero Pipedrive calls here. Counts refresh whenever a rep actually opens a
 * queue; a null count means "not built yet, open it to count".
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const owner = (new URL(req.url).searchParams.get("owner") ?? "both") as OwnerScope;

  const db = supabaseAdmin();
  const [queuesRes, countsRes] = await Promise.all([
    db
      .from("queue_config")
      .select("id, name, stage_ids, priority, cadence_days, is_primary, pool_mode")
      .order("priority"),
    db
      .from("queue_counts")
      .select("queue_id, count, updated_at")
      .eq("actor", user.email)
      .eq("owner_scope", owner),
  ]);
  if (queuesRes.error) return NextResponse.json({ error: "db error" }, { status: 500 });

  const countByQueue = new Map(
    (countsRes.data ?? []).map((c) => [c.queue_id, { count: c.count, at: c.updated_at }])
  );
  const out: any[] = (queuesRes.data ?? []).map((q) => ({
    ...q,
    count: countByQueue.get(q.id)?.count ?? null,
    countedAt: countByQueue.get(q.id)?.at ?? null,
  }));

  // Sprints assigned to this user surface as queues (⚡). Sprint dialing
  // runs entirely off the CRM mirror — zero Pipedrive calls.
  const { data: sprints } = await db
    .from("crm_sprints")
    .select("id, name, crm_sprint_items ( called_at )")
    .eq("owner", user.email)
    .eq("status", "active")
    .order("created_at", { ascending: false });
  for (const s of sprints ?? []) {
    const remainingCount = (s.crm_sprint_items ?? []).filter((i: any) => !i.called_at).length;
    out.push({
      id: `sprint:${s.id}`,
      name: `⚡ ${s.name}`,
      is_primary: false,
      pool_mode: false,
      sprint: true,
      count: remainingCount,
    });
  }
  return NextResponse.json({ queues: out });
}
