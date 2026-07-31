import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getSessionUser } from "@/lib/auth";
import { authUrl, klaviyoOauthConfigured, pkcePair } from "@/lib/klaviyo-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Account-level Klaviyo OAuth (admin connects once for the whole team). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));
  if (user.role !== "admin") return NextResponse.redirect(new URL("/whatsapp", req.url));
  if (!klaviyoOauthConfigured()) {
    return NextResponse.json({ error: "Klaviyo OAuth app not configured yet" }, { status: 503 });
  }
  const state = crypto.randomBytes(16).toString("hex");
  const { verifier, challenge } = pkcePair();
  const res = NextResponse.redirect(authUrl(state, challenge));
  const cookieOpts = { httpOnly: true, secure: true, sameSite: "lax" as const, maxAge: 600, path: "/api/klaviyo" };
  res.cookies.set("klaviyo_oauth_state", state, cookieOpts);
  res.cookies.set("klaviyo_oauth_verifier", verifier, cookieOpts);
  return res;
}
