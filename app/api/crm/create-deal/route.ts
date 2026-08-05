import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { createDealFromEmail, createDealFromPhone } from "@/lib/deal-create";

export const runtime = "nodejs";

/**
 * Create a deal from any email (Klaviyo profile via Lookup, Shopify
 * customer, manual entry). Admin + sales.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    email?: string;
    phone?: string;
    name?: string;
    title?: string;
    ownerPipedriveId?: number;
    pipedriveStageId?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.email && !body.phone) {
    return NextResponse.json({ error: "email or phone required" }, { status: 400 });
  }

  // Sales reps create deals owned by themselves; admins choose.
  const ownerPipedriveId =
    user.role === "admin" ? body.ownerPipedriveId ?? null : user.pipedriveUserId;

  try {
    // Phone path (manual dial): the caller may have no email at all.
    const result = body.phone
      ? await createDealFromPhone(supabaseAdmin(), {
          phone: body.phone,
          name: body.name ?? null,
          email: body.email ?? null,
          title: body.title ?? null,
          ownerPipedriveId,
          pipedriveStageId: body.pipedriveStageId ?? 44, // Intake default
          sourceName: "Manual dial",
        })
      : await createDealFromEmail(supabaseAdmin(), {
          email: body.email!,
          name: body.name ?? null,
          title: body.title ?? null,
          ownerPipedriveId,
          pipedriveStageId: body.pipedriveStageId ?? 44, // Intake default
        });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "create failed" },
      { status: 500 }
    );
  }
}
