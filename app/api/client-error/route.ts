import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Crash telemetry from the browser/companion — see migration 00100. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { kind?: string; message?: string; stack?: string; url?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  await supabaseAdmin().from("client_errors").insert({
    user_email: user.email,
    kind: String(body.kind ?? "error").slice(0, 30),
    message: String(body.message ?? "").slice(0, 1000),
    stack: String(body.stack ?? "").slice(0, 6000),
    url: String(body.url ?? "").slice(0, 500),
    user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300),
  });
  return NextResponse.json({ ok: true });
}
