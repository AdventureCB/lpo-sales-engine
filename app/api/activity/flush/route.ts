import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_CFG = {
  idle_ms: 90_000,
  heartbeat_ms: 25_000,
  idle_tail_credit_ms: 30_000,
  kpi_hours: 4,
  calling_prefixes: ["/dialer", "/lists", "/hot-list", "/crm/deal"],
};

const STATES = new Set(["talking", "dialing", "between", "other"]);
const MAX_INTERVALS = 200;
const MAX_LOOKBACK_MS = 30 * 60_000; // buffered retries after an outage still land
const MAX_INTERVAL_MS = 4 * 3600_000;

/** Auth probe + config for the client tracker. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data } = await supabaseAdmin().from("rep_activity_config").select("config").eq("id", true).maybeSingle();
  return NextResponse.json({ config: { ...DEFAULT_CFG, ...((data?.config as object) ?? {}) } });
}

/**
 * Interval flush. Client times are performance.now() offsets — mapped to
 * server clock at receipt (wall-clock changes on the client can't stretch
 * time) and clamped. Rows are idempotent by client_interval_id: the open
 * interval grows in place across flushes; out-of-order arrivals never
 * shrink a recorded end.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    deviceId?: string;
    perfNow?: number;
    intervals?: { cid?: string; state?: string; surface?: string; startPerf?: number; endPerf?: number }[];
  };
  try {
    body = JSON.parse(await req.text()); // sendBeacon may post as a Blob — parse raw
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { deviceId, perfNow } = body;
  const intervals = (body.intervals ?? []).slice(0, MAX_INTERVALS);
  if (!deviceId || typeof perfNow !== "number" || intervals.length === 0) {
    return NextResponse.json({ ok: true, stored: 0 });
  }

  const now = Date.now();
  const toServer = (p: number) => now - (perfNow - p);

  const rows: {
    client_interval_id: string;
    rep_email: string;
    device_id: string;
    state: string;
    surface: string | null;
    started_at: string;
    ended_at: string;
    updated_at: string;
  }[] = [];
  for (const it of intervals) {
    if (!it.cid || !STATES.has(it.state ?? "") || typeof it.startPerf !== "number" || typeof it.endPerf !== "number") continue;
    let start = toServer(it.startPerf);
    let end = toServer(it.endPerf);
    if (!(end > start)) continue;
    start = Math.max(start, now - MAX_LOOKBACK_MS - MAX_INTERVAL_MS);
    end = Math.min(end, now + 5_000);
    if (end - start > MAX_INTERVAL_MS) start = end - MAX_INTERVAL_MS;
    if (end < now - MAX_LOOKBACK_MS) continue; // entirely too stale to witness
    rows.push({
      client_interval_id: it.cid,
      rep_email: user.email,
      device_id: String(deviceId).slice(0, 64),
      state: it.state!,
      surface: (it.surface ?? "").slice(0, 80) || null,
      started_at: new Date(start).toISOString(),
      ended_at: new Date(end).toISOString(),
      updated_at: new Date(now).toISOString(),
    });
  }
  if (rows.length === 0) return NextResponse.json({ ok: true, stored: 0 });

  const db = supabaseAdmin();
  // Never let a late-arriving flush shrink an interval another flush already grew.
  const { data: existing } = await db
    .from("rep_activity_intervals")
    .select("client_interval_id, started_at, ended_at")
    .in("client_interval_id", rows.map((r) => r.client_interval_id));
  const prev = new Map((existing ?? []).map((e) => [e.client_interval_id, e]));
  for (const r of rows) {
    const p = prev.get(r.client_interval_id);
    if (p) {
      if (p.started_at < r.started_at) r.started_at = p.started_at;
      if (p.ended_at > r.ended_at) r.ended_at = p.ended_at;
    }
  }

  const { error } = await db
    .from("rep_activity_intervals")
    .upsert(rows, { onConflict: "client_interval_id" });
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ ok: true, stored: rows.length });
}
