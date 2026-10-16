import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { computeRepKpis, computeWeekly } from "@/lib/rep-kpis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Per-rep KPIs — served from the hourly snapshot (rep_kpi_snapshots), never
 * recomputed on page load. ?rep=<email> → one rep (admins any rep, a rep only
 * their own) incl. the weekly series. ?fresh=1 (admin) → recompute now and
 * refresh the snapshot for that window.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const onlyRep = (params.get("rep") ?? "").trim().toLowerCase() || null;
  if (user.role !== "admin" && (!onlyRep || onlyRep !== user.email.toLowerCase())) return NextResponse.json({ error: "admin only" }, { status: 403 });
  const days = [7, 14, 30, 90].includes(Number(params.get("days"))) ? Number(params.get("days")) : 30;
  const fresh = params.get("fresh") === "1" && user.role === "admin";
  const db = supabaseAdmin();

  let q = db.from("rep_kpi_snapshots").select("rep_email, computed_at, payload, weekly").eq("days", days);
  if (onlyRep) q = q.ilike("rep_email", onlyRep);
  const { data: snaps } = fresh ? { data: null as any[] | null } : await q;

  if (!fresh && snaps && snaps.length) {
    const reps = snaps.map((s: any) => s.payload).sort((a: any, b: any) => b.book.open - a.book.open);
    return NextResponse.json({ days, computedAt: snaps.map((s: any) => s.computed_at).sort()[0], reps, weekly: onlyRep ? snaps[0].weekly ?? [] : undefined, fromSnapshot: true });
  }

  // No snapshot yet (or admin asked for fresh): compute now and store it.
  try {
    const res = await computeRepKpis(db, days, onlyRep);
    const rows = await Promise.all(res.reps.map(async (r) => ({ days, rep_email: r.email.toLowerCase(), computed_at: res.computedAt, payload: r, weekly: onlyRep ? res.weekly ?? [] : await computeWeekly(db, r.email) })));
    if (rows.length) await db.from("rep_kpi_snapshots").upsert(rows, { onConflict: "days,rep_email" });
    return NextResponse.json({ days, computedAt: res.computedAt, reps: res.reps, weekly: res.weekly, fromSnapshot: false });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
