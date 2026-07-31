import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { gmailConfigured } from "@/lib/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Is this rep's Gmail connected? Powers the header button. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!gmailConfigured()) return NextResponse.json({ configured: false, connected: false });
  const { data } = await supabaseAdmin()
    .from("gmail_accounts")
    .select("google_email, status, last_synced_at")
    .eq("user_email", user.email)
    .maybeSingle();
  return NextResponse.json({
    configured: true,
    connected: Boolean(data && data.status !== "disconnected"),
    googleEmail: data?.google_email ?? null,
    lastSyncedAt: data?.last_synced_at ?? null,
  });
}
