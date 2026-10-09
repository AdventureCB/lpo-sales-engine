import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { linkVisitor, mergeFromVisitorLink } from "@/lib/attribution";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Klaviyo email-click identity. Links in Klaviyo emails carry `_kx=<token>`;
 * attr.js posts it on landing and we ask Klaviyo which profile it belongs to
 * (Profiles API: filter=equals(_kx,"…")). That names the visitor on arrival —
 * before this, an email clicker stayed anonymous unless they typed their email
 * on the site (only 17 of 209 clicks in a week were identifiable).
 */

const ALLOWED_ORIGINS = new Set(["https://www.lonepeakoverland.com", "https://lonepeakoverland.com", "https://lone-peak-overland.myshopify.com"]);
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

export async function POST(req: NextRequest) {
  const headers = cors(req);
  let body: { vid?: string; kx?: string };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400, headers });
  }
  const vid = typeof body.vid === "string" ? body.vid.trim().slice(0, 64) : null;
  const kx = typeof body.kx === "string" ? body.kx.trim().slice(0, 300) : null;
  if (!vid || !/^[a-f0-9-]{16,64}$/i.test(vid) || !kx || !/^[A-Za-z0-9_\-%.=]{8,300}$/.test(kx)) {
    return NextResponse.json({ ok: true, linked: false }, { headers });
  }

  const db = supabaseAdmin();
  // One Klaviyo lookup per (visitor, token).
  const cacheKey = `kx:${vid}:${kx.slice(0, 40)}`;
  const { data: seen } = await db.from("crm_sync_state").select("value").eq("key", cacheKey).maybeSingle();
  let email: string | null = (seen?.value as any)?.email ?? null;
  if (!seen) {
    try {
      const url = `https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(`equals(_kx,"${kx}")`)}&fields[profile]=email`;
      const r = await fetch(url, { headers: { Authorization: `Klaviyo-API-Key ${env("KLAVIYO_PRIVATE_KEY")}`, revision: "2024-10-15", accept: "application/vnd.api+json" } });
      const j: any = r.ok ? await r.json() : null;
      email = (j?.data?.[0]?.attributes?.email ?? "").toLowerCase() || null;
    } catch {
      email = null;
    }
    await db.from("crm_sync_state").upsert({ key: cacheKey, value: { email, at: new Date().toISOString() }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ ok: true, linked: false }, { headers });

  const linked = await linkVisitor(db, { attr_vid: vid }, email);
  try { await mergeFromVisitorLink(db, email); } catch {}
  try {
    const { syncWebSignals } = await import("@/lib/web-signals");
    await syncWebSignals(db, { visitorIds: [vid], sinceHours: 90 * 24 });
  } catch {}
  return NextResponse.json({ ok: true, linked }, { headers });
}
