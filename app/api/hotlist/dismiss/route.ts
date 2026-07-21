import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { envOptional } from "@/lib/env";
import { getHotLabelId, getDeal, setDealLabels } from "@/lib/pipedrive";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Dismiss a hot flag: clear it, start cooldown, remove the label. Audited.
 * Sales users can only dismiss flags on deals they own.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { flagId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.flagId) return NextResponse.json({ error: "flagId required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: flag } = await db
    .from("hot_flags")
    .select("id, deal_id, deal_title, owner_pipedrive_id")
    .eq("id", body.flagId)
    .maybeSingle();
  if (!flag) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (user.role === "sales" && flag.owner_pipedrive_id !== user.pipedriveUserId) {
    return NextResponse.json({ error: "not your deal" }, { status: 403 });
  }

  const { error } = await db
    .from("hot_flags")
    .update({ cleared_at: new Date().toISOString(), dismissed_by: user.email })
    .eq("id", flag.id);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  await db.from("admin_corrections").insert({
    actor: user.email,
    action: "dismiss_hot_flag",
    target: `deal ${flag.deal_id} (${flag.deal_title ?? "?"})`,
    reason: "manual dismiss from hot list",
  });

  if (envOptional("PIPEDRIVE_API_TOKEN")) {
    try {
      const hotLabelId = await getHotLabelId();
      if (hotLabelId) {
        const deal = await getDeal(flag.deal_id);
        if (deal.label_ids.includes(hotLabelId)) {
          await setDealLabels(flag.deal_id, deal.label_ids.filter((l) => l !== hotLabelId));
        }
      }
    } catch (e) {
      console.error("label removal on dismiss failed", e);
    }
  }

  return NextResponse.json({ ok: true });
}
