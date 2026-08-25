import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { provisionRepCalling } from "@/lib/telnyx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Re-run rep calling provisioning for every active rep with a Telnyx number.
 * Idempotent (provisionRepCalling self-heals missing SIP logins / number
 * pointing) — used for port-day repairs without needing the Settings UI.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const { data: reps } = await db
    .from("reps")
    .select("id, name, telnyx_number, telnyx_connection_id, telnyx_credential_id")
    .eq("active", true)
    .not("telnyx_number", "is", null);
  const results: Record<string, string> = {};
  for (const rep of reps ?? []) {
    try {
      await provisionRepCalling(db, rep, rep.telnyx_number as string);
      results[rep.name] = "ok";
    } catch (e) {
      results[rep.name] = e instanceof Error ? e.message : "failed";
    }
  }
  return NextResponse.json({ ok: true, results });
}
