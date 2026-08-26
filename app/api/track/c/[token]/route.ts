import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public click-tracking redirect for rep Gmail sends. The destination is
 * looked up by index from the links stored at SEND time — this is not an
 * open redirector; unknown tokens/indexes fall back to the homepage.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const idx = Number(new URL(req.url).searchParams.get("i") ?? -1);
  let url: string | null = null;
  if (/^[a-f0-9-]{36}$/i.test(token) && Number.isInteger(idx) && idx >= 0 && idx < 200) {
    try {
      const { data } = await supabaseAdmin().rpc("email_track_click", { p_token: token, p_index: idx });
      if (typeof data === "string" && /^https?:\/\//i.test(data)) url = data;
    } catch {
      /* fall through to homepage */
    }
  }
  return NextResponse.redirect(url ?? "https://www.lonepeakoverland.com", 302);
}
