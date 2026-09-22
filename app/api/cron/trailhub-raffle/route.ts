import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { runTrailhubRaffle } from "@/lib/trailhub-raffle";
import type { IntakeSource } from "@/lib/intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Trailhub raffle intake — twice daily (pg_cron 8am / 4pm PT). Feeds the
 * "Trailhub Raffle" intake engine from Trailhub's raffle_entries.
 * ?dry=1 reads Trailhub and reports what WOULD happen without writing
 * (works even while the engine is disabled — use it to verify the connection).
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const db = supabaseAdmin();
  const { data: src } = await db.from("intake_sources").select("*").eq("adapter", "trailhub_raffle").limit(1).maybeSingle();
  if (!src) return NextResponse.json({ error: "no trailhub_raffle engine" }, { status: 404 });
  if (!src.enabled && !dry) return NextResponse.json({ ok: true, skipped: "engine disabled" });
  try {
    return NextResponse.json(await runTrailhubRaffle(db, src as IntakeSource, { dry }));
  } catch (e) {
    console.error("trailhub raffle intake failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
