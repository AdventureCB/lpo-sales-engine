import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { exchangeCode } from "@/lib/klaviyo-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.cookies.get("klaviyo_oauth_state")?.value;
  const verifier = req.cookies.get("klaviyo_oauth_verifier")?.value;
  if (!code || !state || !verifier || state !== cookieState) {
    return NextResponse.redirect(new URL("/whatsapp?klaviyo=error", req.url));
  }

  try {
    const tok = await exchangeCode(code, verifier);
    const { error } = await supabaseAdmin().from("klaviyo_oauth").upsert(
      {
        id: 1,
        access_token: tok.accessToken,
        refresh_token: tok.refreshToken,
        token_expires_at: tok.expiresAt,
        scopes: tok.scopes,
        connected_by: user.email,
        status: "active",
        last_error: null,
        connected_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error("klaviyo oauth callback failed", e);
    return NextResponse.redirect(new URL("/whatsapp?klaviyo=error", req.url));
  }
  const res = NextResponse.redirect(new URL("/whatsapp?klaviyo=connected", req.url));
  res.cookies.delete("klaviyo_oauth_state");
  res.cookies.delete("klaviyo_oauth_verifier");
  return res;
}
