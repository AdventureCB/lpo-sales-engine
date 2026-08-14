import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { createDealFromEmail, createDealFromPhone } from "@/lib/deal-create";

export const runtime = "nodejs";

/**
 * Create a deal from any email/phone — Klaviyo profile (Lookup), Shopify
 * customer, or a rep's manual entry. Admin + sales. Both email and phone may
 * be supplied; existing-open-deal dedupe prevents duplicates.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    email?: string;
    phone?: string;
    name?: string;
    title?: string;
    valueCents?: number | null;
    sourceName?: string;
    ownerPipedriveId?: number;
    pipedriveStageId?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const email = body.email?.trim() || null;
  const phone = body.phone?.trim() || null;
  if (!email && !phone) return NextResponse.json({ error: "email or phone required" }, { status: 400 });

  // Sales reps create deals owned by themselves; admins choose.
  const ownerPipedriveId = user.role === "admin" ? body.ownerPipedriveId ?? null : user.pipedriveUserId;
  const stageId = body.pipedriveStageId ?? 44; // Intake- Needs Qualification default
  const sourceName = body.sourceName?.trim() || "Manual entry";
  const db = supabaseAdmin();

  try {
    let result;
    if (email) {
      // Email path handles value + source + an attached phone in one write.
      result = await createDealFromEmail(db, {
        email,
        name: body.name ?? null,
        title: body.title ?? null,
        ownerPipedriveId,
        pipedriveStageId: stageId,
        valueCents: body.valueCents ?? null,
        providedPhone: phone,
        enrichPhone: false,
        sourceName,
      });
    } else {
      // Phone-only path (person-by-phone dedupe, links existing open deal).
      result = await createDealFromPhone(db, {
        phone: phone!,
        name: body.name ?? null,
        title: body.title ?? null,
        ownerPipedriveId,
        pipedriveStageId: stageId,
        sourceName,
      });
      // createDealFromPhone has no value field — set it on the mirror.
      if (result.created && result.crmDealId && body.valueCents != null) {
        await db.from("crm_deals").update({ value_cents: body.valueCents }).eq("id", result.crmDealId);
      }
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "create failed" }, { status: 500 });
  }
}
