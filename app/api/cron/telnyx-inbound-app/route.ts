import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { getSessionUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { ensureInboundApp } from "@/lib/telnyx";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * One-shot (idempotent) provisioning: ensure the "lpo-inbound" Call Control
 * application exists and every assigned number routes through it — required
 * for voicemail (credential connections refuse API answer). Admin or cron.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!isAuthorizedCron(req) && user?.role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await ensureInboundApp(supabaseAdmin());
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
