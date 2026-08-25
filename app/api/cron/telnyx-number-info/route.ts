import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { envOptional } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API = "https://api.telnyx.com/v2";

/**
 * Diagnostic: a number's messaging configuration straight from Telnyx —
 * messaging profile, features, and 10DLC campaign association. Built for
 * port-day debugging (SMS "delivered" but filtered = usually a missing
 * campaign assignment). Cron-auth so it's reachable without the portal.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const key = envOptional("TELNYX_API_KEY");
  if (!key) return NextResponse.json({ error: "telnyx not configured" }, { status: 200 });
  const headers = { Authorization: `Bearer ${key}` };
  const g = async (path: string) => {
    const r = await fetch(`${API}${path}`, { headers });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  const db = supabaseAdmin();
  const { data: reps } = await db.from("reps").select("name, telnyx_number").eq("active", true).not("telnyx_number", "is", null);
  const out: Record<string, unknown> = {};
  // ?phone=+1509… adds an arbitrary number to the report (comparison against a known-good line)
  const extra = new URL(req.url).searchParams.get("phone");
  const targets = [...(reps ?? []).map((r) => ({ name: r.name as string, num: r.telnyx_number as string })), ...(extra ? [{ name: "extra", num: extra }] : [])];
  for (const { name, num } of targets) {
    const enc = encodeURIComponent(num);
    const [msg, campPathPlus, campPathBare, campQuery, pnc] = await Promise.all([
      g(`/messaging_phone_numbers/${enc}`),
      g(`/10dlc/phoneNumberAssignmentByPhoneNumber/${enc}`),
      g(`/10dlc/phoneNumberAssignmentByPhoneNumber/${enc.replace("%2B", "")}`),
      g(`/10dlc/phoneNumberAssignmentByPhoneNumber?phoneNumber=${enc}`),
      g(`/phone_number_campaigns/${enc}`),
    ]);
    const campaign = [campPathPlus, campPathBare, campQuery, pnc].find((c) => c.status === 200) ?? campPathBare;
    out[`${name} (${num})`] = {
      messaging: {
        profile_id: msg.json?.data?.messaging_profile_id ?? null,
        product: msg.json?.data?.messaging_product ?? null,
        features: msg.json?.data?.features ?? null,
        http: msg.status,
      },
      tenDlcCampaign: {
        http: campaign.status,
        body: campaign.json?.data ?? campaign.json ?? null,
        variants: { pathPlus: campPathPlus.status, pathBare: campPathBare.status, query: campQuery.status, phoneNumberCampaigns: pnc.status },
        phoneNumberCampaign: pnc.json?.data ?? pnc.json ?? null,
      },
    };
  }
  return NextResponse.json({ ok: true, numbers: out });
}
