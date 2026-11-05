import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { processOpsEvents, validateOpsEvent, verifyOpsSignature } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Ops → Sales Engine signed webhook (docs/ops-integration.md §4).
 *   POST { events: [...] }  with X-Ops-Signature (sha256= base64 HMAC of the
 *   raw body, keyed OPS_WEBHOOK_SECRET) + X-Ops-Timestamp (unix s, 5-min window).
 *   ?dry=1 validates and reports without writing.
 * Replies 200 {ok, accepted, duplicates} once stored; 401 bad signature;
 * 400 malformed, naming the first bad event. Duplicate event_ids are ignored.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  // Ops signs with OPS_WEBHOOK_SECRET; our own admin tooling may post sample
  // batches with the cron secret instead (contract §10 test plan).
  if (!isAuthorizedCron(req)) {
    const sig = verifyOpsSignature(rawBody, req.headers.get("x-ops-signature"), req.headers.get("x-ops-timestamp"));
    if (!sig.ok) return NextResponse.json({ ok: false, error: sig.error }, { status: 401 });
  }
  let body: { events?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const events = Array.isArray(body?.events) ? body.events : null;
  if (!events || events.length === 0 || events.length > 100) return NextResponse.json({ ok: false, error: "events must be an array of 1–100" }, { status: 400 });
  for (const e of events) {
    const bad = validateOpsEvent(e);
    if (bad) return NextResponse.json({ ok: false, error: bad, event_id: (e as any)?.event_id ?? null }, { status: 400 });
  }
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  try {
    const r = await processOpsEvents(supabaseAdmin(), events as any[], { dry, via: "webhook" });
    return NextResponse.json({ ok: true, dry, accepted: r.accepted, duplicates: r.duplicates, errors: r.errors, results: r.results });
  } catch (e) {
    console.error("ops webhook failed", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
