import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { OPS_BASE, opsPrefill, reviewCredit } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rep actions toward Ops (docs/ops-integration.md v2):
 *   POST {action:"prefill", dealId}           → hands the customer's details to Ops
 *        server-to-server, returns the PII-free deep link to open
 *   POST {action:"credit", quoteId, decision:"approve"|"flag", note?}
 *        → the deal owner confirms or flags Ops' sale credit after first payment
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: any = {};
  try { body = await req.json(); } catch {}
  const db = supabaseAdmin();

  if (body.action === "prefill" && typeof body.dealId === "string") {
    const { data: d } = await db.from("crm_deals").select("id, crm_contacts ( name, first_name, last_name, emails, phones )").eq("id", body.dealId).maybeSingle();
    if (!d) return NextResponse.json({ error: "deal not found" }, { status: 404 });
    const c: any = (d as any).crm_contacts ?? {};
    const emails = (c.emails as any[]) ?? [];
    const phones = (c.phones as any[]) ?? [];
    const pr = await opsPrefill(d.id, {
      name: c.name ?? null, first_name: c.first_name ?? null, last_name: c.last_name ?? null,
      email: (emails.find((e) => e.primary && e.value && !e.bad) ?? emails.find((e) => e.value && !e.bad))?.value?.toLowerCase() ?? null,
      phone: (phones.find((p) => p.primary && !p.bad) ?? phones.find((p) => !p.bad))?.e164 ?? null,
    });
    const url = `${OPS_BASE}/builds/sales?${new URLSearchParams({ tab: "quote", source: "sales-engine", crm_deal_id: d.id })}`;
    // A failed prefill still opens the form (the rep types the details).
    return NextResponse.json({ ok: true, url, prefilled: pr.ok, ...(pr.ok ? {} : { prefillError: pr.error }) });
  }

  if (body.action === "credit" && typeof body.quoteId === "string" && (body.decision === "approve" || body.decision === "flag")) {
    const r = await reviewCredit(db, body.quoteId, user, body.decision, typeof body.note === "string" ? body.note.slice(0, 500) : null);
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 400 });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
