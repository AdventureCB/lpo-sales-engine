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
    const token = await webrtcToken(db, state.credentialId);
    // Caller ID: the rep's own assigned number when set, else account default.
    let callerNumber = state.callerNumber;
    if (user.repId) {
      const { data: rep } = await db.from("reps").select("telnyx_number").eq("id", user.repId).maybeSingle();
      if (rep?.telnyx_number) callerNumber = rep.telnyx_number;
    }
    return NextResponse.json({ configured: true, token, callerNumber });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("telnyx token", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
