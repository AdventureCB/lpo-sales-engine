import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { normalizePhone } from "@/lib/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Caller-ID lookup: phone → CRM contact + their most relevant deal. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const phone = normalizePhone(new URL(req.url).searchParams.get("phone"));
  if (!phone) return NextResponse.json({ contact: null });

  const db = supabaseAdmin();
  const { data: contact } = await db
    .from("crm_contacts")
    .select("id, name")
    .contains("phones", JSON.stringify([{ e164: phone }]))
    .maybeSingle();
  if (!contact) return NextResponse.json({ contact: null });

  const { data: deal } = await db
    .from("crm_deals")
    .select("id, title, status, pipedrive_deal_id")
    .eq("contact_id", contact.id)
    .order("status", { ascending: true }) // "open" sorts before "won"/"lost"
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    contact: { id: contact.id, name: contact.name },
    deal: deal
      ? { crmDealId: deal.id, title: deal.title, pipedriveDealId: deal.pipedrive_deal_id }
      : null,
  });
}
