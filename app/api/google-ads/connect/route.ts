import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { adsAuthUrl } from "@/lib/google-ads";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin-only: start the Google Ads OAuth consent (same client as Gmail). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const state = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(adsAuthUrl(state));
  res.cookies.set("ads_oauth_state", state, { httpOnly: true, secure: true, maxAge: 600, path: "/" });
  return res;
}
