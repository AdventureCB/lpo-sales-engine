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

    const rows = (items ?? []).map((it: any) => {
      const d = it.crm_deals;
      const phones = d?.crm_contacts?.phones ?? [];
      const phone = phones.find((p: any) => p.primary && p.e164)?.e164 ?? phones.find((p: any) => p.e164)?.e164 ?? null;
      return {
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
 * Edit a list: remove/restore an item, add a deal, or archive the list.
 * POST { op: 'remove'|'restore'|'add'|'archive', sprintId, dealId? }
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();

  let body: { op?: string; sprintId?: string; dealId?: string };
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

  if (!dealId) return NextResponse.json({ error: "dealId required" }, { status: 400 });

  if (op === "remove") {
    await db.from("crm_sprint_items").update({ removed_at: new Date().toISOString() }).eq("sprint_id", sprintId).eq("deal_id", dealId);
    return NextResponse.json({ ok: true });
  }
  if (op === "restore") {
    await db.from("crm_sprint_items").update({ removed_at: null }).eq("sprint_id", sprintId).eq("deal_id", dealId);
    return NextResponse.json({ ok: true });
  }
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
