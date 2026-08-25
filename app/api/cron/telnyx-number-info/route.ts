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
  for (const rep of reps ?? []) {
    const num = rep.telnyx_number as string;
    const enc = encodeURIComponent(num);
    const [msg, campaign] = await Promise.all([
      g(`/messaging_phone_numbers/${enc}`),
      g(`/10dlc/phoneNumberAssignmentByPhoneNumber?phoneNumber=${enc.replace("%2B", "")}`),
    ]);
    out[`${rep.name} (${num})`] = {
      messaging: {
        profile_id: msg.json?.data?.messaging_profile_id ?? null,
        product: msg.json?.data?.messaging_product ?? null,
        features: msg.json?.data?.features ?? null,
        http: msg.status,
      },
      tenDlcCampaign: { http: campaign.status, body: campaign.json?.data ?? campaign.json ?? null },
    };
  }
  return NextResponse.json({ ok: true, numbers: out });
}
