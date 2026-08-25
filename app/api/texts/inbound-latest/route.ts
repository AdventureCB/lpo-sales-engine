import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * New inbound texts on MY assigned Telnyx number since `after` — polled by
 * the root-mounted watcher that pops the chat dock + top banner.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!user.repId) return NextResponse.json({ messages: [] });

  const after = req.nextUrl.searchParams.get("after");
  const afterIso = after && Number.isFinite(Date.parse(after)) ? new Date(Date.parse(after)).toISOString() : new Date().toISOString();

  const db = supabaseAdmin();
  const { data: rep } = await db.from("reps").select("telnyx_number").eq("id", user.repId).maybeSingle();
  if (!rep?.telnyx_number) return NextResponse.json({ messages: [] });

  const { data: rows } = await db
    .from("sms_messages")
    .select("id, peer_phone, body, media, sent_at")
    .eq("direction", "incoming")
    .eq("our_number", rep.telnyx_number)
    .gt("sent_at", afterIso)
    .order("sent_at", { ascending: true })
    .limit(8);

  return NextResponse.json({
    messages: (rows ?? []).map((m) => ({
      id: m.id,
      phone: m.peer_phone,
      body: m.body,
      hasMedia: Array.isArray(m.media) && m.media.length > 0,
      at: m.sent_at,
    })),
  });
}
