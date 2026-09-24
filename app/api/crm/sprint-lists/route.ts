import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint Lists surface: list a user's lists, or preview one list's items.
 *   GET               → lists (admin: all; rep: own) with counts
 *   GET ?sprintId=X   → that list's items with deal details (for preview/edit)
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const sprintId = new URL(req.url).searchParams.get("sprintId");

  if (sprintId) {
    const { data: sprint } = await db
      .from("crm_sprints")
      .select("id, name, owner, kind, slot, for_date, cap, status")
      .eq("id", sprintId)
      .maybeSingle();
    if (!sprint) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (user.role !== "admin" && sprint.owner !== user.email)
      return NextResponse.json({ error: "not your list" }, { status: 403 });

    const { data: items } = await db
      .from("crm_sprint_items")
      .select(
        "deal_id, position, tier, tier_label, source, tz_bucket, flag, called_at, removed_at, added_manually, disposition, crm_deals ( id, title, status, pipedrive_deal_id, value_cents, crm_stages ( name, crm_pipelines ( name ) ), crm_contacts ( name, phones ) )"
      )
      .eq("sprint_id", sprintId)
      .order("position");

    // Last-30-day attempts / conversations per deal (Kyle 9/24) — same
    // definitions as the Ad ROI funnel and the CRM call-stat columns, but
    // windowed, so a rep sees recent effort at a glance without opening it.
    const dealIds = (items ?? []).map((it: any) => it.deal_id).filter(Boolean);
    const pdIds = (items ?? []).map((it: any) => it.crm_deals?.pipedrive_deal_id).filter((x: any) => x != null);
    const pdToDeal = new Map<number, string>((items ?? []).filter((it: any) => it.crm_deals?.pipedrive_deal_id != null).map((it: any) => [it.crm_deals.pipedrive_deal_id, it.deal_id]));
    const att30 = new Map<string, number>();
    const con30 = new Map<string, number>();
    if (dealIds.length) {
      const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const [{ data: ce }, { data: acts }] = await Promise.all([
        db
          .from("call_events")
          .select("crm_deal_id, deal_id, direction, disposition, classification")
          .gte("started_at", since30)
          .or(`crm_deal_id.in.(${dealIds.join(",")})${pdIds.length ? `,deal_id.in.(${pdIds.join(",")})` : ""}`),
        db.from("crm_activities").select("deal_id").eq("type", "call").like("actor", "%@%").is("due_at", null).gte("occurred_at", since30).in("deal_id", dealIds),
      ]);
      const bump = (m: Map<string, number>, id: string | null | undefined) => { if (id) m.set(id, (m.get(id) ?? 0) + 1); };
      for (const c of ce ?? []) {
        const id = c.crm_deal_id ?? (c.deal_id != null ? pdToDeal.get(c.deal_id) : null);
        if (c.direction === "outgoing") bump(att30, id);
        if (c.disposition === "connected" || (c.classification === "conversation" && (c.disposition == null || c.disposition === "connected"))) bump(con30, id);
      }
      for (const a of acts ?? []) bump(att30, a.deal_id);
    }

    const rows = (items ?? []).map((it: any) => {
      const d = it.crm_deals;
      const phones = d?.crm_contacts?.phones ?? [];
      const phone = phones.find((p: any) => p.primary && p.e164)?.e164 ?? phones.find((p: any) => p.e164)?.e164 ?? null;
      return {
        attempts30: att30.get(it.deal_id) ?? 0,
        convos30: con30.get(it.deal_id) ?? 0,
        dealId: it.deal_id,
        pipedriveDealId: d?.pipedrive_deal_id ?? null,
        title: d?.title ?? "(deleted)",
        personName: d?.crm_contacts?.name ?? null,
        phone,
        stageName: d?.crm_stages?.name ?? "—",
        pipelineName: d?.crm_stages?.crm_pipelines?.name ?? "—",
        dealStatus: d?.status ?? "open",
        valueCents: d?.value_cents ?? null,
        tier: it.tier,
        tierLabel: it.tier_label,
        source: it.source,
        tzBucket: it.tz_bucket,
        flag: it.flag,
        calledAt: it.called_at,
        removedAt: it.removed_at,
        addedManually: it.added_manually,
        disposition: it.disposition,
      };
    });
    return NextResponse.json({ sprint, items: rows });
  }

  // List of lists.
  let q = db
    .from("crm_sprints")
    .select("id, name, owner, kind, slot, for_date, cap, status, created_at, crm_sprint_items ( called_at, removed_at )")
    .neq("status", "archived")
    .order("kind")
    .order("slot", { nullsFirst: false })
    .order("created_at", { ascending: false });
  if (user.role !== "admin") q = q.eq("owner", user.email);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  const lists = (data ?? []).map((s: any) => {
    const items = s.crm_sprint_items ?? [];
    return {
      id: s.id,
      name: s.name,
      owner: s.owner,
      kind: s.kind,
      slot: s.slot,
      forDate: s.for_date,
      cap: s.cap,
      status: s.status,
      total: items.filter((i: any) => !i.removed_at).length,
      called: items.filter((i: any) => i.called_at && !i.removed_at).length,
      removed: items.filter((i: any) => i.removed_at).length,
    };
  });
  return NextResponse.json({ lists });
}

/**
 * Edit a list: remove/restore an item, add a deal, archive the list, or
 * bulk-snooze deals off ALL call lists until a date.
 * POST { op: 'remove'|'restore'|'add'|'archive'|'snooze', sprintId, dealId?, dealIds?, until? }
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();

  let body: { op?: string; sprintId?: string; dealId?: string; dealIds?: string[]; until?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { op, sprintId, dealId } = body;
  if (!op || !sprintId) return NextResponse.json({ error: "op and sprintId required" }, { status: 400 });

  const { data: sprint } = await db.from("crm_sprints").select("id, owner").eq("id", sprintId).maybeSingle();
  if (!sprint) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (user.role !== "admin" && sprint.owner !== user.email)
    return NextResponse.json({ error: "not your list" }, { status: 403 });

  if (op === "archive") {
    await db.from("crm_sprints").update({ status: "archived" }).eq("id", sprintId);
    return NextResponse.json({ ok: true });
  }

  // remove / restore accept either a single dealId or a dealIds[] (bulk select).
  const targets = body.dealIds?.length ? body.dealIds : dealId ? [dealId] : [];
  if ((op === "remove" || op === "restore") && !targets.length)
    return NextResponse.json({ error: "dealId or dealIds required" }, { status: 400 });

  if (op === "remove") {
    await db.from("crm_sprint_items").update({ removed_at: new Date().toISOString() }).eq("sprint_id", sprintId).in("deal_id", targets);
    return NextResponse.json({ ok: true, count: targets.length });
  }
  if (op === "restore") {
    await db.from("crm_sprint_items").update({ removed_at: null }).eq("sprint_id", sprintId).in("deal_id", targets);
    return NextResponse.json({ ok: true, count: targets.length });
  }

  // Bulk snooze (Kyle 9/24): same effect as the deal page's 😴 action, for
  // every selected deal — excluded from list generation until `until`, a
  // system note on each timeline, and dropped from this list right away.
  if (op === "snooze") {
    const until = body.until ?? "";
    if (!targets.length) return NextResponse.json({ error: "dealIds required" }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return NextResponse.json({ error: "until must be YYYY-MM-DD" }, { status: 400 });
    const todayLa = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
    if (until <= todayLa) return NextResponse.json({ error: "Pick a date after today." }, { status: 400 });
    const now = new Date().toISOString();
    const { error } = await db.from("crm_deals").update({ sprint_snooze_until: until, updated_at: now }).in("id", targets);
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    await db.from("crm_activities").insert(
      targets.map((id) => ({ deal_id: id, type: "system", subject: `😴 Snoozed from call lists until ${until}`, actor: user.email, meta: { bulk: true, sprint_id: sprintId } }))
    );
    await db.from("crm_sprint_items").update({ removed_at: now }).eq("sprint_id", sprintId).in("deal_id", targets);
    return NextResponse.json({ ok: true, count: targets.length, until });
  }

  if (!dealId) return NextResponse.json({ error: "dealId required" }, { status: 400 });
  if (op === "add") {
    const { data: deal } = await db.from("crm_deals").select("id").eq("id", dealId).maybeSingle();
    if (!deal) return NextResponse.json({ error: "deal not found" }, { status: 404 });
    const { data: last } = await db
      .from("crm_sprint_items")
      .select("position")
      .eq("sprint_id", sprintId)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    await db.from("crm_sprint_items").upsert(
      {
        sprint_id: sprintId,
        deal_id: dealId,
        position: (last?.position ?? -1) + 1,
        source: "manual",
        tier_label: "manual",
        added_manually: true,
        removed_at: null,
      },
      { onConflict: "sprint_id,deal_id" }
    );
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}
