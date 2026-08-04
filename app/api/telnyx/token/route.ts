import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { ensureProvisioned, telnyxConfigured, webrtcToken } from "@/lib/telnyx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** WebRTC login token + caller id for the browser dialer. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!telnyxConfigured()) return NextResponse.json({ configured: false }, { status: 503 });
  try {
    const db = supabaseAdmin();
    const state = await ensureProvisioned(db);
    // Reps with their own number get their own identity: their caller ID
    // out, and — via their connection's SIP login — inbound rings them.
    let callerNumber = state.callerNumber;
    if (user.repId) {
      const { data: rep } = await db
        .from("reps")
        .select("telnyx_number")
        .eq("id", user.repId)
        .maybeSingle();
      if (rep?.telnyx_number) callerNumber = rep.telnyx_number;
      const { data: sip } = await db
        .from("crm_sync_state")
        .select("value")
        .eq("key", `telnyx_sip:${user.repId}`)
        .maybeSingle();
      const creds = sip?.value as { login?: string; password?: string } | undefined;
      if (creds?.login && creds?.password) {
        return NextResponse.json({
          configured: true,
          login: creds.login,
          password: creds.password,
          callerNumber,
        });
      }
    }
    const token = await webrtcToken(db, state.credentialId);
    return NextResponse.json({ configured: true, token, callerNumber });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("telnyx token", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
