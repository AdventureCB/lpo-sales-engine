import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { envOptional } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const API = "https://api.telnyx.com/v2";

/**
 * Assign every active rep's Telnyx number's MESSAGING PROFILE to the approved
 * 10DLC campaign (profile-wide assignment covers current + future numbers on
 * that profile). Port-day repair: a number with a profile but NO campaign
 * association sends "delivered" SMS that carriers silently filter.
 * Idempotent; ?dry=1 previews without assigning.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const key = envOptional("TELNYX_API_KEY");
  if (!key) return NextResponse.json({ error: "telnyx not configured" }, { status: 200 });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const g = async (path: string) => {
    const r = await fetch(`${API}${path}`, { headers });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  // The account's 10DLC campaigns (expect exactly one approved).
  const camps = await g(`/10dlc/campaign?page=1&recordsPerPage=10`);
  const records: any[] = camps.json?.records ?? camps.json?.data ?? [];
  const campaign = records.find((c) => /accept|approved|active/i.test(String(c.status ?? c.campaignStatus ?? ""))) ?? records[0];
  const campaignId = campaign?.campaignId ?? campaign?.id ?? null;
  if (!campaignId) {
    return NextResponse.json({ ok: false, reason: "no 10DLC campaign found", campaigns: camps });
  }

  const db = supabaseAdmin();
  const { data: reps } = await db.from("reps").select("name, telnyx_number").eq("active", true).not("telnyx_number", "is", null);
  const results: Record<string, unknown> = { campaignId, campaignStatus: campaign?.status ?? campaign?.campaignStatus ?? null };
  const profilesDone = new Set<string>();
  for (const rep of reps ?? []) {
    const num = rep.telnyx_number as string;
    const msg = await g(`/messaging_phone_numbers/${encodeURIComponent(num)}`);
    const profileId = msg.json?.data?.messaging_profile_id ?? null;
    if (!profileId) {
      results[`${rep.name} (${num})`] = "no messaging profile — attach one in the portal first";
      continue;
    }
    if (profilesDone.has(profileId)) {
      results[`${rep.name} (${num})`] = `profile ${profileId} already submitted this run`;
      continue;
    }
    profilesDone.add(profileId);
    if (dry) {
      results[`${rep.name} (${num})`] = { wouldAssign: { messagingProfileId: profileId, campaignId } };
      continue;
    }
    const r = await fetch(`${API}/10dlc/phoneNumberAssignmentByProfile`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messagingProfileId: profileId, campaignId }),
    });
    results[`${rep.name} (${num})`] = { http: r.status, body: await r.json().catch(() => null) };
  }
  return NextResponse.json({ ok: true, dry, results });
}
