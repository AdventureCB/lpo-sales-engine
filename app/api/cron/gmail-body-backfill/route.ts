import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { getSessionUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { backfillGmailBodies, gmailConfigured } from "@/lib/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One-time repair for pre-8/18 gmail activities that only stored the snippet.
 * Call repeatedly until remaining=0 (each call is budget-bounded). Admin or cron.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!isAuthorizedCron(req) && user?.role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!gmailConfigured()) return NextResponse.json({ ok: true, skipped: "not configured" });
  const limit = Math.min(300, Number(new URL(req.url).searchParams.get("limit")) || 150);
  const result = await backfillGmailBodies(supabaseAdmin(), 45_000, limit);
  return NextResponse.json({ ok: true, ...result });
}
