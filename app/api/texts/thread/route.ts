import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { normalizePhone } from "@/lib/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Full message history with one counterparty, oldest→newest. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const phone = normalizePhone(new URL(req.url).searchParams.get("phone"));
  if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: rows, error } = await db
    .from("sms_messages")
    .select("id, rep_id, direction, status, our_number, body, sent_at")
    .eq("peer_phone", phone)
    .order("sent_at", { ascending: false })
    .limit(300);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  const { data: reps } = await db.from("reps").select("id, name");
  const repName = new Map((reps ?? []).map((r) => [r.id, r.name]));

  return NextResponse.json({
    messages: (rows ?? []).reverse().map((m) => ({
      id: m.id,
      direction: m.direction,
      status: m.status,
      body: m.body,
      at: m.sent_at,
      rep: m.rep_id ? repName.get(m.rep_id) ?? null : null,
      ourNumber: m.our_number,
    })),
  });
}
