import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { adsExchangeCode, saveAdsRefreshToken } from "@/lib/google-ads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OAuth callback: store the Ads refresh token (crm_sync_state). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.redirect(new URL("/login", req.url));

  const params = new URL(req.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const cookieState = req.cookies.get("ads_oauth_state")?.value;
  if (!code || !state || state !== cookieState) {
    return NextResponse.redirect(new URL("/settings?ads=error", req.url));
  }
  try {
    const refreshToken = await adsExchangeCode(code);
    await saveAdsRefreshToken(supabaseAdmin(), refreshToken);
  } catch (e) {
    console.error("google ads oauth failed", e);
    return NextResponse.redirect(new URL("/settings?ads=error", req.url));
  }
  const res = NextResponse.redirect(new URL("/settings?ads=connected", req.url));
  res.cookies.delete("ads_oauth_state");
  return res;
}
