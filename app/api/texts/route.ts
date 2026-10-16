import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Thread list: one row per counterparty, newest first, contact-resolved.
 *  Admins see everything, or one rep's lines with ?rep=<email> (Kyle 9/29). */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  // Reps see only conversations on their own line(s); admins see everything
  // unless they pick a rep.
  let ourNumbers: string[] | null = null;
  const repParam = user.role === "admin" ? (new URL(req.url).searchParams.get("rep") ?? "").trim().toLowerCase() : "";
  if (user.role !== "admin" || repParam) {
    let q = db.from("reps").select("telnyx_number, quo_phone_number");
    q = repParam ? q.eq("email", repParam) : q.eq("id", user.repId ?? "00000000-0000-0000-0000-000000000000");
    const { data: rep } = await q.maybeSingle();
    ourNumbers = [rep?.telnyx_number, rep?.quo_phone_number].filter(Boolean) as string[];
    if (ourNumbers.length === 0) return NextResponse.json({ threads: [] });
  }
  const { data: threads, error } = await db.rpc("sms_threads", { p_limit: 200, p_our_numbers: ourNumbers });
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  const phones = (threads ?? []).map((t: any) => t.peer_phone);
  const contactByPhone = new Map<string, any>();
  const readByPhone = new Map<string, string>();
  const doneByPhone = new Map<string, { at: string; through: string }>();
  if (phones.length > 0) {
    const [{ data: resolved }, { data: reads }, { data: dones }] = await Promise.all([
      db.rpc("contacts_by_phones", { p_phones: phones }),
      db.from("sms_thread_reads").select("peer_phone, read_at").eq("user_email", user.email).in("peer_phone", phones),
      db.from("sms_thread_done").select("peer_phone, done_at, done_through_at").eq("user_email", user.email).in("peer_phone", phones),
    ]);
    for (const r of resolved ?? []) contactByPhone.set(r.phone, r);
    for (const r of reads ?? []) readByPhone.set(r.peer_phone, r.read_at);
    for (const r of dones ?? []) doneByPhone.set(r.peer_phone, { at: r.done_at, through: r.done_through_at });
  }

  return NextResponse.json({
    threads: (threads ?? []).map((t: any) => {
      const c = contactByPhone.get(t.peer_phone);
      const readAt = readByPhone.get(t.peer_phone);
      const dn = doneByPhone.get(t.peer_phone);
      return {
        // Done sticks until a NEWER message lands — then it's back in "to do".
        done: !!dn && Date.parse(t.last_at) <= Date.parse(dn.through) + 1000,
        doneAt: dn && Date.parse(t.last_at) <= Date.parse(dn.through) + 1000 ? dn.at : null,
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

/** Mark a thread read for this user: POST { phone } (called on open/view).
 *  Done checkbox: POST { phone, done: true, lastAt } / { phone, done: false }. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { phone?: string; done?: boolean; lastAt?: string } = {};
  try {
    body = await req.json();
  } catch {}
  if (!body.phone) return NextResponse.json({ error: "phone required" }, { status: 400 });
  if (typeof body.done === "boolean") {
    const db = supabaseAdmin();
    if (!body.done) {
      await db.from("sms_thread_done").delete().eq("user_email", user.email).eq("peer_phone", body.phone);
      return NextResponse.json({ ok: true, done: false });
    }
    // Done "through" the thread's latest message (server-side truth, not the client's stale view).
    const { data: last } = await db.from("sms_messages").select("sent_at").eq("peer_phone", body.phone).order("sent_at", { ascending: false }).limit(1).maybeSingle();
    const through = last?.sent_at ?? body.lastAt ?? new Date().toISOString();
    const now = new Date().toISOString();
    await Promise.all([
      db.from("sms_thread_done").upsert({ user_email: user.email, peer_phone: body.phone, done_at: now, done_through_at: through }, { onConflict: "user_email,peer_phone" }),
      db.from("sms_thread_reads").upsert({ user_email: user.email, peer_phone: body.phone, read_at: now }, { onConflict: "user_email,peer_phone" }),
    ]);
    return NextResponse.json({ ok: true, done: true });
  }
  await supabaseAdmin()
    .from("sms_thread_reads")
    .upsert(
      { user_email: user.email, peer_phone: body.phone, read_at: new Date().toISOString() },
      { onConflict: "user_email,peer_phone" }
    );
  return NextResponse.json({ ok: true });
}
