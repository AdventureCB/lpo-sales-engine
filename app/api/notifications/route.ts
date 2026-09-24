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
  kind: "sms" | "whatsapp" | "missed_call" | "inbound_email" | "booking" | "overdue" | "intake" | "mention" | "outbox";
  group: NotifGroup;
  title: string;
  sub: string | null;
  at: string;
  href: string;
  isNew: boolean;
}

/** Who a notification list is about: null = the whole team (admins only). */
interface Target { repId: string | null; email: string; pipedriveUserId: number | null }

/**
 * Unified rep notifications: new inbound texts + WhatsApp, missed calls,
 * inbound emails, bookings, intake, @mentions, overdue activities.
 * Reps see their own. Admins choose a scope (?scope=team | mine | rep:<id>);
 * the badge follows the scope. The badge counts items that APPEARED after
 * the user last looked (hovering/opening the bell marks seen) — overdue
 * tasks included, so a stale pile never pins the count (Kyle 9/23).
 * POST {markSeen:true} stamps seen_at; {dismiss|dismissKeys} hides items.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const isAdmin = user.role === "admin";
  const nowIso = new Date().toISOString();
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  // Scope → target rep. Non-admins are always themselves.
  const scope = (new URL(req.url).searchParams.get("scope") ?? (isAdmin ? "team" : "mine")).trim();
  let target: Target | null = { repId: user.repId ?? null, email: user.email, pipedriveUserId: user.pipedriveUserId ?? null };
  let reps: { id: string; name: string; email: string }[] = [];
  if (isAdmin) {
    const { data: r } = await db.from("reps").select("id, name, email, pipedrive_user_id").eq("active", true).not("email", "is", null).order("sort_order").order("name");
    reps = (r ?? []).map((x: any) => ({ id: x.id, name: x.name, email: x.email }));
    if (scope === "team") target = null;
    else if (scope.startsWith("rep:")) {
      const rep = (r ?? []).find((x: any) => x.id === scope.slice(4));
      if (rep) target = { repId: rep.id, email: rep.email, pipedriveUserId: rep.pipedrive_user_id ?? null };
    }
  }
  const t = target; // narrowed alias for the filters below
  const scopeUsed = t ? (t.email === user.email ? "mine" : `rep:${t.repId}`) : "team";
  // Rep-keyed tables need a rep id; a scoped target with no rep profile
  // (an admin's "Mine") must match nothing rather than everything.
  const repKey = t ? t.repId ?? "00000000-0000-0000-0000-000000000000" : null;

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
  if (repKey) smsQ = smsQ.eq("rep_id", repKey);

  let callQ = db
    .from("call_events")
    .select("id, started_at, rep_id, raw, classification, transcript:raw->>transcript")
    .eq("direction", "incoming")
    .is("answered_at", null)
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(15);
  if (repKey) callQ = callQ.eq("rep_id", repKey);

  // Inbound emails swept into contact timelines (meta.mailbox = receiving rep).
  let emailQ = db
    .from("crm_activities")
    .select("id, subject, occurred_at, meta, crm_contacts ( name, crm_deals ( id, status, owner_pipedrive_id ) )")
    .eq("type", "email")
    .eq("meta->>direction", "inbound")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(15);
  if (t) emailQ = emailQ.eq("meta->>mailbox", t.email);

  // Online bookings ("Schedule with a Gravel Guide") for this rep.
  let bookQ = db
    .from("bookings")
    .select("id, kind, customer_name, start_at, via, deal_id, created_at, reps ( email )")
    .eq("status", "booked")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(15);
  if (repKey) bookQ = bookQ.eq("rep_id", repKey);

  const mentionSince = new Date(Date.now() - 7 * 86_400_000).toISOString();
  // @mentions are personal: the viewer's own, or the scoped rep's when an admin looks at one rep.
  const mentionEmail = t?.email ?? user.email;
  const [{ data: sms }, { data: wa }, { data: missed }, { data: due }, { data: intake }, { data: mentions }, { data: emails }, { data: bookings }] = await Promise.all([
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
      .contains("meta", { mentions: [mentionEmail] })
      .neq("actor", mentionEmail)
      .gte("occurred_at", mentionSince)
      .order("occurred_at", { ascending: false })
      .limit(20),
    emailQ,
    bookQ,
  ]);

  const intakeItems = (intake ?? []).filter((e: any) => {
    if ((e.intake_sources?.config as any)?.notify_owner !== true) return false;
    if (!t) return true;
    return t.pipedriveUserId != null && e.crm_deals?.owner_pipedrive_id === t.pipedriveUserId;
  });

  const overdue = (due ?? []).filter(
    (a: any) =>
      !t ||
      a.actor === t.email ||
      (t.pipedriveUserId && a.crm_deals?.owner_pipedrive_id === t.pipedriveUserId)
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

  // Campaign emails waiting for approval (scoped like everything else).
  let outboxQ = db.from("campaign_sends").select("id, created_at, campaigns ( name )").eq("status", "draft").order("created_at", { ascending: false }).limit(50);
  if (t) outboxQ = outboxQ.eq("owner_email", t.email);
  const { data: outboxRows } = await outboxQ;
  const outboxItems: Notif[] = (outboxRows ?? []).length
    ? [{
        key: `outbox:${(outboxRows ?? [])[0].created_at}`,
        kind: "outbox",
        group: "tasks",
        title: `📬 ${(outboxRows ?? []).length} campaign email${(outboxRows ?? []).length === 1 ? "" : "s"} awaiting approval`,
        sub: [...new Set((outboxRows ?? []).map((r: any) => r.campaigns?.name).filter(Boolean))].slice(0, 3).join(" · ") || null,
        at: (outboxRows ?? [])[0].created_at,
        href: "/outbox",
        isNew: (outboxRows ?? [])[0].created_at > seenAt,
      }]
    : [];

  const allItems: Notif[] = [
    ...outboxItems,
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
    ...(emails ?? []).map((e: any): Notif => {
      const deals = (e.crm_contacts?.crm_deals ?? []) as any[];
      const deal = deals.find((d) => d.status === "open") ?? deals[0];
      return {
        key: `email:${e.id}`,
        kind: "inbound_email",
        group: "comms",
        title: `✉️ ${e.crm_contacts?.name ?? "New email"}`,
        sub: (e.subject ?? "").replace(/^📥\s*/, "").slice(0, 90) || "New email",
        at: e.occurred_at,
        // No deal on the contact → open the CRM searched for them instead of the bare list.
        href: deal?.id ? `/crm/deal/${deal.id}` : `/crm?q=${encodeURIComponent(e.crm_contacts?.name ?? "")}`,
        isNew: e.occurred_at > seenAt,
      };
    }),
    ...(bookings ?? []).map((b: any): Notif => ({
      key: `booking:${b.id}`,
      kind: "booking",
      group: "tasks",
      title: `${b.kind === "showroom" ? "🏠 Showroom appointment booked" : b.kind === "confirm" ? "✅ Order confirmation booked" : "📅 New call booked"} — ${b.customer_name}`,
      sub: `${new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(b.start_at))} PT${b.via === "round_robin" ? " · round robin" : ""}`,
      at: b.created_at,
      href: b.deal_id ? `/crm/deal/${b.deal_id}` : "/calendar",
      isNew: b.created_at > seenAt,
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
      isNew: a.due_at > seenAt, // became overdue since you last looked
    })),
  ];

  // Drop items this user has dismissed.
  const { data: dis } = await db.from("notif_dismissals").select("notif_key").eq("user_email", user.email);
  const dismissed = new Set((dis ?? []).map((d) => d.notif_key));
  const items = allItems.filter((i) => !dismissed.has(i.key));

  // Badge = what appeared since the last look. Overdue tasks still show in the
  // panel (highlighted, with a count in the header) but don't pin the badge.
  const badge = items.filter((i) => i.isNew).length;
  const counts: Record<NotifGroup, number> = { deals: 0, notes: 0, comms: 0, tasks: 0 };
  for (const i of items) counts[i.group]++;

  return NextResponse.json({
    badge,
    overdueCount: items.filter((i) => i.kind === "overdue").length,
    counts,
    scope: scopeUsed,
    ...(isAdmin ? { reps } : {}),
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
