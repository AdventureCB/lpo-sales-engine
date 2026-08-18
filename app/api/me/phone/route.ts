import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Does this rep receive inbound on a Telnyx number? Drives whether the
 * browser softphone must stay registered regardless of dial-method choice. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let telnyxInbound = false;
  if (user.repId) {
    const { data: rep } = await supabaseAdmin()
      .from("reps")
      .select("telnyx_number")
      .eq("id", user.repId)
      .maybeSingle();
    telnyxInbound = Boolean(rep?.telnyx_number);
  }
  return NextResponse.json({ telnyxInbound });
}
