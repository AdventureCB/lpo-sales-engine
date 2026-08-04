import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

/**
 * Call-quality dashboard. Quality exists on Telnyx-path calls: client-side
 * WebRTC stats (raw.client_quality) and Telnyx RTCP MOS
 * (raw.event…call_quality_stats). Per-rep averages; ?rep=<id> → last 50.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const repFilter = new URL(req.url).searchParams.get("rep");

  const db = supabaseAdmin();
  const { data: reps } = await db.from("reps").select("id, name").eq("active", true).order("sort_order");

  let q = db
    .from("call_events")
    .select(
      "quo_call_id, rep_id, started_at, duration_s, disposition, quality:raw->client_quality, mos:raw->event->data->payload->call_quality_stats->inbound->>mos"
    )
    .gte("started_at", new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString())
    .not("raw->client_quality", "is", null)
    .order("started_at", { ascending: false });
  if (repFilter) q = q.eq("rep_id", repFilter).limit(50);
  else q = q.limit(1000);
  const { data: calls, error } = await q;
  if (error) {
    console.error("quality query", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  if (repFilter) {
    return NextResponse.json({
      calls: (calls ?? []).map((c: any) => ({
        at: c.started_at,
        durationS: c.duration_s,
        disposition: c.disposition,
        avgLossPct: c.quality?.avg_loss_pct ?? null,
        maxJitterMs: c.quality?.max_jitter_ms ?? null,
        mos: c.mos ? Number(c.mos) : null,
      })),
    });
  }

  const repName = new Map((reps ?? []).map((r) => [r.id, r.name]));
  const agg = new Map<string, { rep: string; repId: string; n: number; loss: number; jitter: number; mosSum: number; mosN: number }>();
  for (const c of calls ?? []) {
    if (!c.rep_id) continue;
    let a = agg.get(c.rep_id);
    if (!a) {
      agg.set(c.rep_id, (a = { rep: repName.get(c.rep_id) ?? "Unknown", repId: c.rep_id, n: 0, loss: 0, jitter: 0, mosSum: 0, mosN: 0 }));
    }
    a.n++;
    a.loss += (c as any).quality?.avg_loss_pct ?? 0;
    a.jitter += (c as any).quality?.max_jitter_ms ?? 0;
    const mos = (c as any).mos ? Number((c as any).mos) : null;
    if (mos) {
      a.mosSum += mos;
      a.mosN++;
    }
  }
  const summary = [...agg.values()].map((a) => ({
    rep: a.rep,
    repId: a.repId,
    calls: a.n,
    avgLossPct: Number((a.loss / a.n).toFixed(2)),
    avgMaxJitterMs: Math.round(a.jitter / a.n),
    avgMos: a.mosN ? Number((a.mosSum / a.mosN).toFixed(2)) : null,
  }));
  return NextResponse.json({ summary, windowDays: WINDOW_DAYS });
}
