import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { envOptional } from "@/lib/env";
import { ingestTypeformResponse } from "@/lib/typeform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Typeform webhook: verify the HMAC, then hand the payload to the shared
 * ingest (raw storage + ad attribution + Intake Engine routing). The
 * Responses-API backfill cron runs the exact same ingest, so a submission
 * arriving both ways lands once (idempotent by response token).
 */

function verifySignature(raw: string, req: NextRequest): boolean {
  const secret = envOptional("TYPEFORM_WEBHOOK_SECRET");
  if (!secret) return true; // not configured yet — accept (endpoint is obscure, data is inert)
  const sig = req.headers.get("typeform-signature") ?? "";
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifySignature(raw, req)) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (body?.event_type !== "form_response" || !body?.form_response)
    return NextResponse.json({ ok: true, ignored: true });

  try {
    const res = await ingestTypeformResponse(supabaseAdmin(), body);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    console.error("typeform ingest failed", e);
    return NextResponse.json({ error: "ingest failed" }, { status: 500 });
  }
}
