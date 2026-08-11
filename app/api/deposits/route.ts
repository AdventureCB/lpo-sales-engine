import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open Deposits: every open deal sitting in Deposit Placed / Confirmation
 * Scheduled — how long it's been sitting (journey deposit time when the
 * payment is known, else the stage-change time) and whether a confirmation
 * follow-up is actually scheduled. The page that keeps deposits moving.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();

  const { data: stages } = await db
    .from("crm_stages")
    .select("id, name")
    .or("name.ilike.%deposit placed%,name.ilike.%confirmation scheduled%");
  const stageIds = (stages ?? []).map((s) => s.id);
  if (stageIds.length === 0) return NextResponse.json({ deposits: [] });

  const { data: deals } = await db
    .from("crm_deals")
    .select(
      "id, title, value_cents, owner_pipedrive_id, stage_changed_at, pipedrive_deal_id, contact_id, crm_stages ( name ), crm_contacts ( name, phones )"
    )
    .eq("status", "open")
    .in("stage_id", stageIds)
    .limit(500);

  const rows = deals ?? [];
  const dealIds = rows.map((d) => d.id);
  const pdIds = rows.map((d) => d.pipedrive_deal_id).filter(Boolean) as number[];

  const [{ data: acts }, { data: journeys }] = await Promise.all([
    dealIds.length
      ? db
          .from("crm_activities")
          .select("deal_id, subject, type, due_at")
          .in("deal_id", dealIds)
          .is("done_at", null)
          .not("due_at", "is", null)
          .order("due_at")
      : Promise.resolve({ data: [] as any[] }),
    pdIds.length
      ? db
          .from("sales_journeys")
          .select("pipedrive_deal_id, deposit_started_at")
          .in("pipedrive_deal_id", pdIds)
          .not("deposit_started_at", "is", null)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const nextAct = new Map<string, { subject: string | null; type: string; dueAt: string }>();
  for (const a of acts ?? []) {
    if (!nextAct.has(a.deal_id)) nextAct.set(a.deal_id, { subject: a.subject, type: a.type, dueAt: a.due_at });
  }
  const depositAt = new Map<number, string>();
  for (const j of journeys ?? []) {
    const cur = depositAt.get(j.pipedrive_deal_id);
    if (!cur || j.deposit_started_at < cur) depositAt.set(j.pipedrive_deal_id, j.deposit_started_at);
  }

  const now = Date.now();
  const deposits = rows
    .map((d: any) => {
      const since =
        (d.pipedrive_deal_id ? depositAt.get(d.pipedrive_deal_id) : null) ?? d.stage_changed_at ?? null;
      const act = nextAct.get(d.id) ?? null;
      return {
        dealId: d.id,
        title: d.title,
        personName: d.crm_contacts?.name ?? null,
        valueCents: d.value_cents,
        ownerPipedriveId: d.owner_pipedrive_id,
        stageName: d.crm_stages?.name ?? "—",
        depositAt: since,
        daysSitting: since ? Math.floor((now - Date.parse(since)) / 86_400_000) : null,
        nextActivity: act,
        overdueActivity: act ? act.dueAt < new Date().toISOString() : false,
      };
    })
    .sort((a, b) => (b.daysSitting ?? 0) - (a.daysSitting ?? 0));

  return NextResponse.json({ deposits });
}
