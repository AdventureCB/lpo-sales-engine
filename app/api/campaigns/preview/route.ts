import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { generateCampaignEmail } from "@/lib/campaign-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Admin: dry-run an AI step prompt against a real deal (nothing is saved or sent). */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { dealId?: string; prompt?: string; steering?: string; campaignName?: string; stepPosition?: number; stepCount?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.dealId || !body.prompt?.trim()) return NextResponse.json({ error: "dealId and prompt required" }, { status: 400 });
  const db = supabaseAdmin();
  const { data: deal } = await db.from("crm_deals").select("id, owner_email, owner_pipedrive_id").eq("id", body.dealId).maybeSingle();
  if (!deal) return NextResponse.json({ error: "deal not found" }, { status: 404 });
  const { dealOwnerEmail } = await import("@/lib/campaigns");
  const owner = (await dealOwnerEmail(db, deal)) ?? user.email;
  const { data: rep } = await db.from("reps").select("name").eq("email", owner).maybeSingle();
  try {
    const gen = await generateCampaignEmail(db, {
      dealId: deal.id,
      campaignName: body.campaignName?.trim() || "Preview",
      stepPosition: Math.max(0, Number(body.stepPosition ?? 0)),
      stepCount: Math.max(1, Number(body.stepCount ?? 1)),
      prompt: body.prompt,
      steering: body.steering ?? null,
      repName: rep?.name ?? owner.split("@")[0],
      ownerEmail: owner,
      priorSends: [],
    });
    return NextResponse.json({ ok: true, from: owner, ...gen });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "generation failed" }, { status: 500 });
  }
}
