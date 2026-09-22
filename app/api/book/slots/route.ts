import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { availableSlots, bookableReps, loadBookingConfig, loadBookingEngine, roundRobinReps } from "@/lib/booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUBLIC. Available slot starts (UTC ISO) for a rep (?rep=<slug>) or the
 * round-robin pool (?rep=rr — the guides ticked in the booking intake engine).
 * The customer's browser renders them in the zone they choose; reps' hours
 * are Pacific.
 */
export async function GET(req: NextRequest) {
  const slug = (new URL(req.url).searchParams.get("rep") ?? "rr").toLowerCase();
  const db = supabaseAdmin();
  const [cfg, reps, engine] = await Promise.all([loadBookingConfig(db), bookableReps(db), loadBookingEngine(db)]);
  if (slug === "rr") {
    const slots = await availableSlots(db, { reps: roundRobinReps(reps, engine) }, cfg);
    return NextResponse.json({ rep: null, slotMinutes: cfg.slot_minutes, slots: slots.map((s) => new Date(s).toISOString()) });
  }
  const rep = reps.find((r) => r.slug === slug);
  if (!rep) return NextResponse.json({ error: "unknown guide" }, { status: 404 });
  const slots = await availableSlots(db, { rep }, cfg);
  return NextResponse.json({
    rep: { first: rep.first, name: rep.name, slug: rep.slug },
    slotMinutes: cfg.slot_minutes,
    slots: slots.map((s) => new Date(s).toISOString()),
  });
}
