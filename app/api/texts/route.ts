import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Thread list: one row per counterparty, newest first, contact-resolved. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  // Reps see only conversations on their own line(s); admins see everything.
  let ourNumbers: string[] | null = null;
  if (user.role !== "admin") {
    if (!user.repId) return NextResponse.json({ threads: [] });
    const { data: rep } = await db
      .from("reps")
      .select("telnyx_number, quo_phone_number")
      .eq("id", user.repId)
      .maybeSingle();
    ourNumbers = [rep?.telnyx_number, rep?.quo_phone_number].filter(Boolean) as string[];
    if (ourNumbers.length === 0) return NextResponse.json({ threads: [] });
  }
  const { data: threads, error } = await db.rpc("sms_threads", { p_limit: 200, p_our_numbers: ourNumbers });
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  const phones = (threads ?? []).map((t: any) => t.peer_phone);
  const contactByPhone = new Map<string, any>();
  const readByPhone = new Map<string, string>();
  if (phones.length > 0) {
    const [{ data: resolved }, { data: reads }] = await Promise.all([
      db.rpc("contacts_by_phones", { p_phones: phones }),
      db.from("sms_thread_reads").select("peer_phone, read_at").eq("user_email", user.email).in("peer_phone", phones),
    ]);
    for (const r of resolved ?? []) contactByPhone.set(r.phone, r);
    for (const r of reads ?? []) readByPhone.set(r.peer_phone, r.read_at);
  }

  return NextResponse.json({
    threads: (threads ?? []).map((t: any) => {
      const c = contactByPhone.get(t.peer_phone);
      const readAt = readByPhone.get(t.peer_phone);
      return {
        phone: t.peer_phone,
        lastAt: t.last_at,
        lastBody: t.last_body,
        lastDirection: t.last_direction,
        awaitingReply: t.awaiting_reply,
        // Unread = last message is inbound AND newer than when this user last
        // opened the thread. Opening (ChatWindow) POSTs the read mark.
        unread: Boolean(t.awaiting_reply) && (!readAt || t.last_at > readAt),
        count: t.msg_count,
        contactName: c?.contact_name ?? null,
        crmDealId: c?.crm_deal_id ?? null,
        dealTitle: c?.deal_title ?? null,
      };
    }),
  });
}

/** Mark a thread read for this user: POST { phone } (called on open/view). */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { phone?: string } = {};
  try {
    body = await req.json();
  } catch {}
  if (!body.phone) return NextResponse.json({ error: "phone required" }, { status: 400 });
  await supabaseAdmin()
    .from("sms_thread_reads")
    .upsert(
      { user_email: user.email, peer_phone: body.phone, read_at: new Date().toISOString() },
      { onConflict: "user_email,peer_phone" }
    );
  return NextResponse.json({ ok: true });
}
