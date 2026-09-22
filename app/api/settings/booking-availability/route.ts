import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { loadBookingConfig, repBookingUrl, type RepHours } from "@/lib/booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A rep's own booking availability (My Profile), or — for admins — any rep's
 * (?repId=). Hours are a per-rep override of the team defaults; null = default.
 */
async function targetRep(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const asked = new URL(req.url).searchParams.get("repId");
  const repId = asked && user.role === "admin" ? asked : user.repId;
  if (!repId) return { error: NextResponse.json({ error: "no rep profile on this account" }, { status: 400 }) };
  return { user, repId };
}

export async function GET(req: NextRequest) {
  const t = await targetRep(req);
  if ("error" in t) return t.error;
  const db = supabaseAdmin();
  const [{ data: rep }, cfg] = await Promise.all([
    db.from("reps").select("id, name, booking_enabled, booking_slug, booking_hours").eq("id", t.repId).maybeSingle(),
    loadBookingConfig(db),
  ]);
  if (!rep) return NextResponse.json({ error: "rep not found" }, { status: 404 });
  return NextResponse.json({
    rep: { id: rep.id, name: rep.name, enabled: !!rep.booking_enabled, slug: rep.booking_slug, url: rep.booking_slug ? repBookingUrl(rep.booking_slug) : null },
    hours: (rep.booking_hours as RepHours | null) ?? null,
    team: { days: cfg.days, start: cfg.start, end: cfg.end, slot_minutes: cfg.slot_minutes },
  });
}

export async function POST(req: NextRequest) {
  const t = await targetRep(req);
  if ("error" in t) return t.error;
  let body: { hours?: RepHours | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  let hours: RepHours | null = null;
  if (body.hours) {
    const h = body.hours;
    const hhmm = (s: unknown) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
    const days = Array.isArray(h.days) ? [...new Set(h.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : undefined;
    const blocked = Array.isArray(h.blocked) ? [...new Set(h.blocked.filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort() : undefined;
    if (h.start != null && !hhmm(h.start)) return NextResponse.json({ error: "Bad start time." }, { status: 400 });
    if (h.end != null && !hhmm(h.end)) return NextResponse.json({ error: "Bad end time." }, { status: 400 });
    if (h.start && h.end && h.start >= h.end) return NextResponse.json({ error: "Start must be before end." }, { status: 400 });
    if (days && days.length === 0) return NextResponse.json({ error: "Pick at least one day (or use the team default)." }, { status: 400 });
    hours = {
      ...(days ? { days } : {}),
      ...(h.start ? { start: h.start } : {}),
      ...(h.end ? { end: h.end } : {}),
      ...(blocked && blocked.length ? { blocked } : {}),
    };
    if (Object.keys(hours).length === 0) hours = null;
  }
  const { error } = await supabaseAdmin().from("reps").update({ booking_hours: hours }).eq("id", t.repId);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ ok: true, hours });
}
