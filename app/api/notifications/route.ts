import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 48 * 3600_000; // messages/calls look-back
const OVERDUE_WINDOW_MS = 14 * 86_400_000; // don't resurface ancient tasks

type NotifGroup = "deals" | "notes" | "comms" | "tasks";
interface Notif {
  key: string; // stable id for dismissal
  kind: "sms" | "whatsapp" | "missed_call" | "overdue" | "intake" | "mention";
  group: NotifGroup;
  title: string;
  sub: string | null;
  at: string;
  href: string;
  isNew: boolean;
}

/**
 * Unified rep notifications: new inbound texts + WhatsApp, missed calls,
 * overdue activities. Reps see their own; admins see everything.
 * POST {markSeen:true} clears the new-item badge (overdue stays until done).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const isAdmin = user.role === "admin";
  const nowIso = new Date().toISOString();
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  const { data: st } = await db
    .from("user_notif_state")
    .select("seen_at")
    .eq("user_email", user.email)
    .maybeSingle();
  const seenAt = st?.seen_at ?? since;

  let smsQ = db
    .from("sms_messages")
    .select("id, peer_phone, body, sent_at, rep_id")
    .eq("direction", "incoming")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(15);
  if (!isAdmin && user.repId) smsQ = smsQ.eq("rep_id", user.repId);

  let callQ = db
    .from("call_events")
    .select("id, started_at, rep_id, raw, classification, transcript:raw->>transcript")
    .eq("direction", "incoming")
    .is("answered_at", null)
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(15);
  if (!isAdmin && user.repId) callQ = callQ.eq("rep_id", user.repId);

  const mentionSince = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [{ data: sms }, { data: wa }, { data: missed }, { data: due }, { data: intake }, { data: mentions }] = await Promise.all([
    smsQ,
    db
      .from("whatsapp_messages")
      .select("klaviyo_message_id, profile_id, body, sent_at, crm_contacts ( name )")
      .eq("direction", "incoming")
      .gte("sent_at", since)
      .order("sent_at", { ascending: false })
      .limit(10),
    callQ,
    db
      .from("crm_activities")
      .select("id, subject, type, due_at, actor, deal_id, crm_deals ( id, title, owner_pipedrive_id )")
      .not("due_at", "is", null)
      .is("done_at", null)
      .lt("due_at", nowIso)
      .gte("due_at", new Date(Date.now() - OVERDUE_WINDOW_MS).toISOString())
      .order("due_at")
      .limit(60),
    // Intake-engine activity on your deals (per-engine notify_owner toggle).
    db
      .from("intake_events")
      .select("id, action, created_at, intake_sources ( label, config ), crm_deals ( id, title, owner_pipedrive_id )")
      .in("action", ["created", "noted", "reopened"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(30),
    // Notes that @mention this user (meta.mentions written at save time).
    db
      .from("crm_activities")
      .select("id, subject, body, actor, occurred_at, crm_deals ( id, title )")
      .contains("meta", { mentions: [user.email] })
      .neq("actor", user.email)
      .gte("occurred_at", mentionSince)
      .order("occurred_at", { ascending: false })
      .limit(20),
  ]);

  const intakeItems = (intake ?? []).filter((e: any) => {
    if ((e.intake_sources?.config as any)?.notify_owner !== true) return false;
    if (isAdmin) return true;
    return user.pipedriveUserId != null && e.crm_deals?.owner_pipedrive_id === user.pipedriveUserId;
  });

  const overdue = (due ?? []).filter(
    (a: any) =>
      isAdmin ||
      a.actor === user.email ||
      (user.pipedriveUserId && a.crm_deals?.owner_pipedrive_id === user.pipedriveUserId)
  );

  // Resolve caller/texter phones to CRM names in one shot.
  const missedPeer = (raw: any): string | null =>
    raw?.data?.object?.participants?.[0] ?? null;
  const phones = [
    ...new Set(
      [...(sms ?? []).map((m) => m.peer_phone), ...(missed ?? []).map((c) => missedPeer(c.raw))].filter(
        Boolean
      )
    ),
  ] as string[];
  const nameByPhone = new Map<string, string>();
  if (phones.length > 0) {
    const { data: resolved } = await db.rpc("contacts_by_phones", { p_phones: phones });
    for (const r of resolved ?? []) if (r.contact_name) nameByPhone.set(r.phone, r.contact_name);
  }

  const allItems: Notif[] = [
    ...(sms ?? []).map((m): Notif => ({
      key: `sms:${m.id}`,
      kind: "sms",
      group: "comms",
      title: `💬 ${nameByPhone.get(m.peer_phone) ?? m.peer_phone}`,
      sub: m.body?.slice(0, 90) ?? null,
      at: m.sent_at,
      href: "/texts",
      isNew: m.sent_at > seenAt,
    })),
    ...(wa ?? []).map((m: any): Notif => ({
      key: `wa:${m.klaviyo_message_id}`,
      kind: "whatsapp",
      group: "comms",
      title: `🟢 ${m.crm_contacts?.name ?? "WhatsApp"}`,
      sub: m.body?.slice(0, 90) ?? null,
      at: m.sent_at,
      href: "/whatsapp",
      isNew: m.sent_at > seenAt,
    })),
    ...(missed ?? []).map((c: any): Notif => {
      const peer = missedPeer(c.raw);
      const who = peer ? nameByPhone.get(peer) ?? peer : "unknown";
      const isVm = c.classification === "voicemail";
      return {
        key: `missed:${c.id}`,
        kind: "missed_call",
        group: "comms",
        title: isVm ? `📼 Voicemail — ${who}` : `📵 Missed call — ${who}`,
        sub: isVm ? (c.transcript ? String(c.transcript).slice(0, 90) : "New voicemail") : null,
        at: c.started_at,
        href: "/call-log",
        isNew: c.started_at > seenAt,
      };
    }),
    ...intakeItems.map((e: any): Notif => ({
      key: `intake:${e.id}`,
      kind: "intake",
      group: e.action === "noted" ? "notes" : "deals",
      title: `🔀 ${e.intake_sources?.label ?? "Intake"} — ${e.action === "created" ? "new deal" : e.action === "reopened" ? "deal reopened" : "new note"}`,
      sub: e.crm_deals?.title ?? null,
      at: e.created_at,
      href: e.crm_deals?.id ? `/crm/deal/${e.crm_deals.id}` : "/crm",
      isNew: e.created_at > seenAt,
    })),
    ...(mentions ?? []).map((a: any): Notif => ({
      key: `mention:${a.id}`,
      kind: "mention",
      group: "notes",
      title: `🏷 ${(a.actor ?? "someone").split("@")[0]} mentioned you`,
      sub: (a.body ?? a.subject ?? "").slice(0, 90) || null,
      at: a.occurred_at,
      href: a.crm_deals?.id ? `/crm/deal/${a.crm_deals.id}` : "/crm",
      isNew: a.occurred_at > seenAt,
    })),
    ...overdue.map((a: any): Notif => ({
      key: `overdue:${a.id}`,
      kind: "overdue",
      group: "tasks",
      title: `⏰ ${a.subject ?? a.type}`,
      sub: a.crm_deals?.title ?? null,
      at: a.due_at,
      href: a.crm_deals?.id ? `/crm/deal/${a.crm_deals.id}` : "/calendar",
      isNew: true, // overdue counts until handled
    })),
  ];

  // Drop items this user has dismissed.
  const { data: dis } = await db.from("notif_dismissals").select("notif_key").eq("user_email", user.email);
  const dismissed = new Set((dis ?? []).map((d) => d.notif_key));
  const items = allItems.filter((i) => !dismissed.has(i.key));

  const badge = items.filter((i) => (i.kind !== "overdue" && i.isNew) || i.kind === "overdue").length;
  const counts: Record<NotifGroup, number> = { deals: 0, notes: 0, comms: 0, tasks: 0 };
  for (const i of items) counts[i.group]++;

  return NextResponse.json({
    badge,
    overdueCount: items.filter((i) => i.kind === "overdue").length,
    counts,
    items: items.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, 60),
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { markSeen?: boolean; dismiss?: string; dismissKeys?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();
  if (body.markSeen) {
    await db
      .from("user_notif_state")
      .upsert(
        { user_email: user.email, seen_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: "user_email" }
      );
  }
  const keys = [body.dismiss, ...(body.dismissKeys ?? [])].filter(Boolean) as string[];
  if (keys.length) {
    await db
      .from("notif_dismissals")
      .upsert(keys.map((k) => ({ user_email: user.email, notif_key: k })), { onConflict: "user_email,notif_key" });
  }
  return NextResponse.json({ ok: true });
}
