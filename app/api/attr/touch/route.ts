import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public beacon: attr.js on lonepeakoverland.com posts ad touches here
 * directly (text/plain body to skip CORS preflight; sendBeacon-friendly).
 * Unauthenticated by necessity — hard-capped per visitor and validated.
 */

const ALLOWED_ORIGINS = new Set([
  "https://www.lonepeakoverland.com",
  "https://lonepeakoverland.com",
  "https://lone-peak-overland.myshopify.com",
]);

function cors(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://www.lonepeakoverland.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
  };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(req) });
}

const STR = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const MAX_TOUCHES_PER_VISITOR = 100;

export async function POST(req: NextRequest) {
  const headers = cors(req);
  let body: { vid?: string; touches?: any[] };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400, headers });
  }
  const vid = STR(body.vid, 64);
  const touches = Array.isArray(body.touches) ? body.touches.slice(0, 20) : [];
  if (!vid || !/^[a-f0-9-]{16,64}$/i.test(vid) || touches.length === 0) {
    return NextResponse.json({ ok: true, stored: 0 }, { headers });
  }

  const db = supabaseAdmin();
  const { count } = await db
    .from("web_touches")
    .select("id", { count: "exact", head: true })
    .eq("visitor_id", vid);
  if ((count ?? 0) >= MAX_TOUCHES_PER_VISITOR) {
    return NextResponse.json({ ok: true, stored: 0, capped: true }, { headers });
  }

  const now = Date.now();
  const rows = touches
    .map((t) => {
      const at = typeof t?.at === "string" ? Date.parse(t.at) : NaN;
      if (!Number.isFinite(at) || at > now + 300_000 || at < now - 120 * 86_400_000) return null;
      return {
        visitor_id: vid,
        at: new Date(at).toISOString(),
        source: STR(t.utm_source, 100),
        medium: STR(t.utm_medium, 100),
        campaign: STR(t.utm_campaign, 150),
        content: STR(t.utm_content, 150),
        term: STR(t.utm_term, 100),
        gclid: STR(t.gclid, 200),
        gbraid: STR(t.gbraid, 200),
        wbraid: STR(t.wbraid, 200),
        fbclid: STR(t.fbclid, 200),
        msclkid: STR(t.msclkid, 200),
        ttclid: STR(t.ttclid, 200),
        landing: STR(t.lp, 300),
        referrer: STR(t.ref, 300),
      };
    })
    .filter(Boolean) as any[];
  if (rows.length === 0) return NextResponse.json({ ok: true, stored: 0 }, { headers });

  // Dedupe against what this visitor already has (same at+source).
  const { data: existing } = await db
    .from("web_touches")
    .select("at, source")
    .eq("visitor_id", vid)
    .in("at", rows.map((r) => r.at));
  const have = new Set((existing ?? []).map((e) => `${new Date(e.at).toISOString()}|${e.source ?? ""}`));
  const fresh = rows.filter((r) => !have.has(`${r.at}|${r.source ?? ""}`)).slice(0, MAX_TOUCHES_PER_VISITOR - (count ?? 0));
  if (fresh.length > 0) await db.from("web_touches").insert(fresh);

  return NextResponse.json({ ok: true, stored: fresh.length }, { headers });
}
