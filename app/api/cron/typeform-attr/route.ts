import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { matchSubmission } from "@/lib/typeform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Retry unmatched Typeform submissions (contact usually appears in the CRM
 * a few minutes after the submission, via Klaviyo→Pipedrive→mirror).
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const { data: pending } = await db
    .from("typeform_submissions")
    .select("id, email, hidden, submitted_at")
    .is("matched_at", null)
    .gte("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString())
    .order("created_at")
    .limit(200);

  let matched = 0;
  for (const sub of pending ?? []) {
    try {
      if (await matchSubmission(db, sub as any)) matched++;
    } catch {}
  }
  return NextResponse.json({ ok: true, pending: (pending ?? []).length, matched });
}
