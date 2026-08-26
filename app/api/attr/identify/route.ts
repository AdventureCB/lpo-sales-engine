import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { linkVisitor, mergeFromVisitorLink } from "@/lib/attribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public identity beacon: attr.js posts {vid, email} whenever a visitor
 * submits an email anywhere on the store (builder save, newsletter, any
 * form). This links the browser's touch history to the person FIRST-PARTY —
 * no dependence on Klaviyo's anonymous-profile merge, which only sticks
 * when the identify happens through Klaviyo's own JS (it usually doesn't
 * for the camper builder). text/plain body → no CORS preflight.
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

export async function POST(req: NextRequest) {
  const headers = cors(req);
  let body: { vid?: string; email?: string };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400, headers });
  }
  const vid = typeof body.vid === "string" ? body.vid.trim().slice(0, 64) : null;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : null;
  if (!vid || !/^[a-f0-9-]{16,64}$/i.test(vid) || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ ok: true, linked: false }, { headers });
  }

  const db = supabaseAdmin();
  const linked = await linkVisitor(db, { attr_vid: vid }, email);

  // Best-effort: fold this visitor's beaconed touches into the contact's
  // attribution when the contact already exists (no-op otherwise — the
  // intake engines run the same merge for contacts created later).
  try {
    await mergeFromVisitorLink(db, email);
  } catch {
    /* best-effort */
  }

  return NextResponse.json({ ok: true, linked }, { headers });
}
