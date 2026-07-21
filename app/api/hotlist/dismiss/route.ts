import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { envOptional } from "@/lib/env";
import { getHotLabelId, getDeal, setDealLabels } from "@/lib/pipedrive";

export const runtime = "nodejs";

/** Dismiss a hot flag: clear it, start cooldown, remove the label. Audited. */
export async function POST(req: NextRequest) {
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
    .select("id, deal_id, deal_title")
    .eq("id", body.flagId)
    .maybeSingle();
  if (!flag) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { error } = await db
    .from("hot_flags")
    .update({ cleared_at: new Date().toISOString(), dismissed_by: "dashboard" })
    .eq("id", flag.id);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  await db.from("admin_corrections").insert({
    actor: "dashboard",
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
