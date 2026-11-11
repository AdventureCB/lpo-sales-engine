import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 1×1 transparent GIF
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/**
 * Public open-tracking pixel for rep Gmail sends. Always returns the gif.
 * IP + user agent go to the RPC so a burst of fetches from one client (the
 * rep's own mail app loading their Sent folder) counts as bulk, not opens.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (/^[a-f0-9-]{36}$/i.test(token)) {
    try {
      const ip = (req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "").split(",")[0].trim() || null;
      const ua = req.headers.get("user-agent")?.slice(0, 300) || null;
      await supabaseAdmin().rpc("email_track_open", { p_token: token, p_ip: ip, p_ua: ua });
    } catch {
      /* never block the pixel */
    }
  }
  return new NextResponse(PIXEL, {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Content-Length": String(PIXEL.length),
    },
  });
}
