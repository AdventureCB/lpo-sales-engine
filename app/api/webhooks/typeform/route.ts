import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { envOptional } from "@/lib/env";
import { matchSubmission } from "@/lib/typeform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Typeform webhook: each survey submission carries the ad identity (URL
 * parameters / hidden fields: utm_*, fbclid, gclid, vid) + the respondent's
 * email. Stored raw, then matched to the CRM contact by email — the deal
 * gets its actual advertising id. Submissions that arrive before the
 * Klaviyo→Pipedrive pipeline creates the contact are retried by cron.
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
  const fr = body?.form_response;
  if (body?.event_type !== "form_response" || !fr) return NextResponse.json({ ok: true, ignored: true });

  const email =
    (fr.answers ?? []).find((a: any) => a?.type === "email" && a?.email)?.email?.toLowerCase()?.trim() ?? null;
  const hidden: Record<string, unknown> = fr.hidden ?? {};
  const formName = fr.definition?.title ?? null;

  const db = supabaseAdmin();
  const { data: row, error } = await db
    .from("typeform_submissions")
    .upsert(
      {
        event_id: String(body.event_id ?? fr.token ?? crypto.randomUUID()).slice(0, 100),
        form_id: fr.form_id ?? null,
        form_name: formName,
        email,
        submitted_at: fr.submitted_at ?? new Date().toISOString(),
        hidden,
      },
      { onConflict: "event_id" }
    )
    .select("id, email, hidden, submitted_at")
    .single();
  if (error || !row) return NextResponse.json({ error: "db error" }, { status: 500 });

  const matched = await matchSubmission(db, row as any);
  return NextResponse.json({ ok: true, matched });
}
