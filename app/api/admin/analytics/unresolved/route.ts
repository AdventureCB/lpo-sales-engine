import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { buildFacebookLabelResolver } from "@/lib/campaign-roas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Meta clicks whose utm_campaign isn't a campaign id, grouped by the labels
 * they carry, with how (or whether) each currently resolves. POST saves an
 * admin alias label → campaign (or clears it), applied to past and future
 * clicks by the attribution code.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const days = Math.min(365, Math.max(7, Number(new URL(req.url).searchParams.get("days")) || 90));
  const db = supabaseAdmin();
  const [{ data: rows, error }, labels, { data: aliases }, { data: adRows }] = await Promise.all([
    db.rpc("unresolved_meta_labels", { p_days: days }),
    buildFacebookLabelResolver(db),
    db.from("campaign_aliases").select("label, campaign_id, campaign_name").eq("channel", "facebook"),
    db.rpc("facebook_ad_campaigns"),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const adMap = new Map<string, string>(((adRows ?? []) as any[]).map((r) => [String(r.ad_id), String(r.campaign_id)]));
  const nameOf = new Map(labels.campaigns.map((c) => [c.id, c.name]));
  const aliasMap = new Map((aliases ?? []).map((a: any) => [String(a.label), a]));
  const out = ((rows ?? []) as any[]).map((r) => {
    const viaAd = /^\d{5,}$/.test(r.content ?? "") ? adMap.get(r.content) ?? null : null;
    const viaLabel = viaAd ? null : labels.resolve(r.label);
    const campaignId = viaAd ?? viaLabel?.campaignId ?? null;
    return {
      label: r.label,
      content: r.content,
      clicks: Number(r.clicks),
      visitors: Number(r.visitors),
      leads: Number(r.leads),
      firstAt: r.first_at,
      lastAt: r.last_at,
      resolvedCampaignId: campaignId,
      resolvedCampaignName: campaignId ? nameOf.get(campaignId) ?? campaignId : null,
      how: viaAd ? "ad id" : viaLabel ? (viaLabel.how === "alias" ? "your assignment" : "name match") : null,
      alias: aliasMap.get(r.label)?.campaign_id ?? null,
    };
  });
  return NextResponse.json({ days, rows: out, campaigns: labels.campaigns });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { label?: string; campaignId?: string | null; campaignName?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const label = (body.label ?? "").trim().toLowerCase();
  if (!label) return NextResponse.json({ error: "label required" }, { status: 400 });
  const db = supabaseAdmin();
  if (!body.campaignId) {
    await db.from("campaign_aliases").delete().eq("channel", "facebook").eq("label", label);
    return NextResponse.json({ ok: true, cleared: true });
  }
  const { error } = await db
    .from("campaign_aliases")
    .upsert({ channel: "facebook", label, campaign_id: String(body.campaignId), campaign_name: body.campaignName ?? null, created_by: user.email }, { onConflict: "channel,label" });
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
