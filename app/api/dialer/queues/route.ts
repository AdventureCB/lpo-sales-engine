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

  // Sprint Lists + manual sprints surface as queues — dialed entirely off the
  // CRM mirror (zero Pipedrive calls). Daily lists show 📋; manual/assigned ⚡.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const { data: sprints } = await db
    .from("crm_sprints")
    .select("id, name, kind, slot, for_date, crm_sprint_items ( called_at, removed_at )")
    .eq("owner", user.email)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  const all = sprints ?? [];
  const dailyToday = all.filter((s: any) => s.kind === "daily" && s.for_date === today);
  const hasList3 = dailyToday.some((s: any) => s.slot === 3);
  // Once List 3 is generated, Lists 1 & 2 drop from the dialer to avoid a
  // data mismatch — List 3 already carries their undialed leads forward.
  const visibleDaily = dailyToday
    .filter((s: any) => !(hasList3 && (s.slot === 1 || s.slot === 2)))
    .sort((a: any, b: any) => (a.slot ?? 9) - (b.slot ?? 9));
  const manual = all.filter((s: any) => s.kind !== "daily");

  for (const s of [...visibleDaily, ...manual]) {
    const items = (s as any).crm_sprint_items ?? [];
    const remaining = items.filter((i: any) => !i.called_at && !i.removed_at).length;
    const isDaily = (s as any).kind === "daily";
    out.push({
      id: `sprint:${s.id}`,
      name: `${isDaily ? "📋" : "⚡"} ${s.name}`,
      is_primary: false,
      pool_mode: false,
      sprint: true,
      daily: isDaily,
      slot: (s as any).slot ?? null,
      count: remaining,
    });
  }
  return NextResponse.json({ queues: out });
}
