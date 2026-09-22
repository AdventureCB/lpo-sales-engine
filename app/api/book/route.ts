import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { availableSlots, bookableReps, createBooking, isBookingKind, loadBookingConfig, loadBookingEngine, pickRoundRobin, roundRobinReps } from "@/lib/booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUBLIC. Create a booking.
 *   { rep: "<slug>" | "rr", name, email, phone, tz, note?, startAt: ISO }
 * The slot must be one the server currently offers (re-generated here, so a
 * stale page can't book a taken or out-of-hours time).
 */
export async function POST(req: NextRequest) {
  let body: { rep?: string; kind?: string; name?: string; email?: string; phone?: string; tz?: string; note?: string; startAt?: string; rebook?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const name = (body.name ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  const email = (body.email ?? "").trim().toLowerCase().slice(0, 200);
  const phone = (body.phone ?? "").trim().slice(0, 40);
  const tz = (body.tz ?? "").trim().slice(0, 64) || "America/Los_Angeles";
  const note = (body.note ?? "").trim().slice(0, 1000) || null;
  const startAt = Date.parse(body.startAt ?? "");
  if (name.length < 2) return NextResponse.json({ error: "Please enter your name." }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "Please enter a valid email." }, { status: 400 });
  if (phone.replace(/\D/g, "").length < 10) return NextResponse.json({ error: "Please enter a valid phone number." }, { status: 400 });
  if (!Number.isFinite(startAt)) return NextResponse.json({ error: "Please pick a time." }, { status: 400 });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return NextResponse.json({ error: "Unknown time zone." }, { status: 400 });
  }

  const db = supabaseAdmin();
  const [cfg, allReps, engine] = await Promise.all([loadBookingConfig(db), bookableReps(db), loadBookingEngine(db)]);
  const slug = (body.rep ?? "rr").toLowerCase();
  const via: "direct" | "round_robin" = slug === "rr" ? "round_robin" : "direct";
  // Round robin rotates over the booking engine's pool; direct links book that guide regardless.
  const rrReps = roundRobinReps(allReps, engine);

  let rep = slug === "rr" ? null : allReps.find((r) => r.slug === slug) ?? null;
  if (via === "direct" && !rep) return NextResponse.json({ error: "unknown guide" }, { status: 404 });

  // The requested time must be a currently-offered slot.
  const offered = await availableSlots(db, rep ? { rep } : { reps: rrReps }, cfg);
  if (!offered.includes(startAt)) {
    return NextResponse.json({ error: "That time was just taken — please pick another." }, { status: 409 });
  }
  if (!rep) rep = await pickRoundRobin(db, rrReps, startAt, cfg);
  if (!rep) return NextResponse.json({ error: "No guide is free at that time — please pick another." }, { status: 409 });

  const rebookToken = body.rebook && /^[a-f0-9]{24}$/.test(body.rebook) ? body.rebook : null;
  const kind = isBookingKind(body.kind) ? body.kind : "call";
  try {
    const r = await createBooking(db, rep, { name, email, phone, tz, note, startAt, via, kind, rebookToken }, cfg);
    return NextResponse.json({ ok: true, rep: { first: rep.first }, startAt: new Date(startAt).toISOString(), ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    if (msg === "slot_taken") return NextResponse.json({ error: "That time was just taken — please pick another." }, { status: 409 });
    console.error("booking failed", e);
    return NextResponse.json({ error: "Something went wrong — please try again." }, { status: 500 });
  }
}
