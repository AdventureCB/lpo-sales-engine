import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Merge candidates for a deal: other deals on the SAME contact (the usual
 * duplicate shape), open first. Plus a free-text search fallback.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dealId = req.nextUrl.searchParams.get("dealId");
  const term = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!dealId) return NextResponse.json({ error: "dealId required" }, { status: 400 });
  const db = supabaseAdmin();

  const { data: deal } = await db.from("crm_deals").select("id, contact_id").eq("id", dealId).maybeSingle();
  if (!deal) return NextResponse.json({ error: "not found" }, { status: 404 });

  const sel = "id, title, status, value_cents, pipedrive_deal_id, created_at, crm_stages(name, crm_pipelines(name)), crm_contacts(name)";
  let q = db.from("crm_deals").select(sel).neq("id", dealId).limit(15);
  if (term) q = q.ilike("title", `%${term}%`);
  else if (deal.contact_id) q = q.eq("contact_id", deal.contact_id);
  else return NextResponse.json({ candidates: [] });

  const { data } = await q;
  const candidates = (data ?? [])
    .map((d: any) => ({
      id: d.id,
      title: d.title,
      status: d.status,
      valueCents: d.value_cents,
      pipeline: d.crm_stages?.crm_pipelines?.name ?? null,
      stage: d.crm_stages?.name ?? null,
      contactName: d.crm_contacts?.name ?? null,
      hasPd: d.pipedrive_deal_id != null,
      createdAt: d.created_at,
    }))
    .sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1));
  return NextResponse.json({ candidates });
}
