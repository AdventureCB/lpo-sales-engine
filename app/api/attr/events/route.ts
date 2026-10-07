import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public beacon: attr.js v2 posts website behavior here (page views, page
 * ends with active dwell / scroll / sections seen, interactions). text/plain
 * body so sendBeacon works without a preflight. Unauthenticated by
 * necessity — validated, size-capped, and rate-capped per visitor.
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

const STR = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const INT = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : null);
const NAMES = new Set(["click", "link", "expand", "tab", "video", "form_start", "form_submit", "outbound", "tel", "mail"]);
const MAX_EVENTS_PER_VISITOR_DAY = 1500;
const ID_RE = /^[a-z0-9-]{8,64}$/i;

export async function POST(req: NextRequest) {
  const headers = cors(req);
  let body: any;
  try {
    const raw = await req.text();
    if (raw.length > 60_000) return NextResponse.json({ error: "too large" }, { status: 413, headers });
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400, headers });
  }
  const vid = STR(body?.vid, 64);
  const sid = STR(body?.sid, 64);
  const events = Array.isArray(body?.events) ? body.events.slice(0, 50) : [];
  if (!vid || !sid || !ID_RE.test(vid) || !ID_RE.test(sid) || events.length === 0) {
    return NextResponse.json({ ok: true, stored: 0 }, { headers });
  }

  const db = supabaseAdmin();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db.from("web_events").select("id", { count: "exact", head: true }).eq("visitor_id", vid).gte("at", dayAgo);
  if ((count ?? 0) >= MAX_EVENTS_PER_VISITOR_DAY) return NextResponse.json({ ok: true, stored: 0, capped: true }, { headers });

  const now = Date.now();
  const rows: Record<string, unknown>[] = [];
  for (const e of events) {
    const at = typeof e?.at === "string" ? Date.parse(e.at) : NaN;
    if (!Number.isFinite(at) || at > now + 300_000 || at < now - 7 * 86_400_000) continue;
    const base = { visitor_id: vid, session_id: sid, at: new Date(at).toISOString(), path: STR(e.p, 300) };
    if (e.t === "pv") rows.push({ ...base, type: "pageview", title: STR(e.ti, 200), referrer: STR(e.r, 300) });
    else if (e.t === "pe") {
      const secs = Array.isArray(e.secs) ? e.secs.map((s: unknown) => STR(s, 60)).filter(Boolean).slice(0, 40) : [];
      rows.push({ ...base, type: "pageend", duration_s: INT(e.dur, 6 * 3600), scroll_pct: INT(e.sc, 100), sections: secs.length ? secs : null });
    } else if (e.t === "ix") {
      const name = STR(e.n, 20);
      if (!name || !NAMES.has(name)) continue;
      rows.push({ ...base, type: "interaction", name, detail: STR(e.d, 200) });
    }
  }
  if (!rows.length) return NextResponse.json({ ok: true, stored: 0 }, { headers });

  const nowIso = new Date().toISOString();
  const [{ error }, _v] = await Promise.all([
    db.from("web_events").insert(rows),
    // Visitor record: Meta cookies + UA for CAPI matching; last_seen for recency.
    db.from("web_visitors").upsert(
      {
        visitor_id: vid,
        last_seen_at: nowIso,
        user_agent: STR(body?.ua, 200),
        ...(STR(body?.fbp, 200) ? { fbp: STR(body.fbp, 200) } : {}),
        ...(STR(body?.fbc, 200) ? { fbc: STR(body.fbc, 200) } : {}),
      },
      { onConflict: "visitor_id" }
    ),
  ]);
  if (error) return NextResponse.json({ error: "db" }, { status: 500, headers });
  return NextResponse.json({ ok: true, stored: rows.length }, { headers });
}
