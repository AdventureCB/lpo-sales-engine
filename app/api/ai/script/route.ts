import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { generateCallScript, generateDraft } from "@/lib/ai-scripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scripts & drafts. kind=call is cheap and cache-first (the dialer preloads
 * it during the review pause); kind=email|sms generate ONLY on explicit rep
 * request. `force` regenerates past the cache.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { dealId?: string; kind?: "call" | "email" | "sms"; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.dealId || !["call", "email", "sms"].includes(body.kind ?? "")) {
    return NextResponse.json({ error: "dealId and kind (call|email|sms) required" }, { status: 400 });
  }
  const db = supabaseAdmin();
  const result =
    body.kind === "call"
      ? await generateCallScript(db, body.dealId, { force: body.force === true })
      : await generateDraft(db, body.dealId, body.kind as "email" | "sms", user.repName, { force: body.force === true });
  if (!result.ok) return NextResponse.json({ error: result.reason ?? "failed" }, { status: 422 });
  return NextResponse.json({ ok: true, kind: body.kind, cached: result.cached === true, script: (result as any).script ?? (result as any).draft });
}
