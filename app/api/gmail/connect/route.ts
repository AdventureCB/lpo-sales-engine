import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getSessionUser } from "@/lib/auth";
import { authUrl, gmailConfigured, redirectUri } from "@/lib/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Kick off per-rep Gmail OAuth. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));
  if (!gmailConfigured()) {
    return NextResponse.json({ error: "Gmail integration not configured yet" }, { status: 503 });
  }
  const state = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authUrl(redirectUri(), state));
  res.cookies.set("gmail_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/gmail",
  });
  return res;
}
