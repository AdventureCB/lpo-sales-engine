import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signing-in user's email signature (appended to every email they send). */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data } = await supabaseAdmin().from("app_users").select("email_signature").eq("id", user.authUserId).maybeSingle();
  return NextResponse.json({ signature: data?.email_signature ?? "" });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { signature?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const sig = (body.signature ?? "").slice(0, 2000);
  const { error } = await supabaseAdmin()
    .from("app_users")
    .update({ email_signature: sig || null })
    .eq("id", user.authUserId);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
