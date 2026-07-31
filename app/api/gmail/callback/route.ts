import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { exchangeCode, REDIRECT_PATH } from "@/lib/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OAuth return leg: store the refresh token against the signed-in rep. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.cookies.get("gmail_oauth_state")?.value;
  if (!code || !state || !cookieState || state !== cookieState) {
    return NextResponse.redirect(new URL("/scoreboard?gmail=error", req.url));
  }

  try {
    const redirectUri = new URL(REDIRECT_PATH, req.url).toString();
    const tok = await exchangeCode(code, redirectUri);
    const db = supabaseAdmin();
    const { error } = await db.from("gmail_accounts").upsert(
      {
        user_email: user.email,
        google_email: tok.googleEmail,
        refresh_token: tok.refreshToken,
        access_token: tok.accessToken,
        token_expires_at: tok.expiresAt,
        status: "active",
        last_error: null,
        connected_at: new Date().toISOString(),
      },
      { onConflict: "user_email" }
    );
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error("gmail callback failed", e);
    return NextResponse.redirect(new URL("/scoreboard?gmail=error", req.url));
  }
  const res = NextResponse.redirect(new URL("/scoreboard?gmail=connected", req.url));
  res.cookies.delete("gmail_oauth_state");
  return res;
}
