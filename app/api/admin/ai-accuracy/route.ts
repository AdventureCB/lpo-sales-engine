import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 5b: outcome feedback (pure reporting — no AI spend). Profiles freeze
 * at close (the engine never touches won/lost deals), so the stored profile
 * IS the close-time snapshot; this joins them against outcomes.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days")) || 90, 7), 365);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const db = supabaseAdmin();
  const { data: rows } = await db
    .from("crm_deals")
    .select("id, status, value_cents, lost_reason, won_at, lost_at, deal_profiles ( archetypes, overall_confidence, corrections, next_action )")
    .in("status", ["won", "lost"])
    .or(`won_at.gte.${cutoff},lost_at.gte.${cutoff}`)
    .limit(2000);

  type Row = { won: boolean; valueCents: number; lostReason: string | null; profile: any | null };
  const deals: Row[] = (rows ?? []).map((d: any) => ({
    won: d.status === "won",
    valueCents: d.value_cents ?? 0,
    lostReason: d.lost_reason ?? null,
    profile: Array.isArray(d.deal_profiles) ? d.deal_profiles[0] ?? null : d.deal_profiles ?? null,
  }));

  const profiled = deals.filter((d) => d.profile && (d.profile.archetypes ?? []).length > 0);
  const unprofiled = deals.filter((d) => !profiled.includes(d));
  const winRate = (list: Row[]) => (list.length ? list.filter((d) => d.won).length / list.length : null);
  const avgConf = (list: Row[]) => {
    const confs = list.map((d) => d.profile?.overall_confidence).filter((c) => c != null).map(Number);
    return confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
  };

  // Per dominant archetype.
  const byArch = new Map<string, { name: string; closed: number; won: number; wonValueCents: number; lostReasons: Record<string, number> }>();
  for (const d of profiled) {
    const top = (d.profile.archetypes as any[]).slice().sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0];
    if (!top?.key) continue;
    const e = byArch.get(top.key) ?? { name: top.name ?? top.key, closed: 0, won: 0, wonValueCents: 0, lostReasons: {} as Record<string, number> };
    e.closed++;
    if (d.won) {
      e.won++;
      e.wonValueCents += d.valueCents;
    } else if (d.lostReason) {
      e.lostReasons[d.lostReason] = (e.lostReasons[d.lostReason] ?? 0) + 1;
    }
    byArch.set(top.key, e);
  }

  // Confidence calibration buckets.
  const buckets = [
    { label: "<40%", min: 0, max: 0.4 },
    { label: "40–60%", min: 0.4, max: 0.6 },
    { label: "60–80%", min: 0.6, max: 0.8 },
    { label: "80%+", min: 0.8, max: 1.01 },
  ].map((b) => {
    const list = profiled.filter((d) => {
      const c = Number(d.profile?.overall_confidence ?? -1);
      return c >= b.min && c < b.max;
    });
    return { label: b.label, n: list.length, won: list.filter((d) => d.won).length };
  });

  // Corrected vs untouched profiles.
  const hasCorrections = (p: any) => {
    const c = p?.corrections ?? {};
    return ["archetypes_wrong", "attributes_cleared", "tags_removed", "interests_removed", "notes"].some(
      (k) => Array.isArray(c[k]) && c[k].length > 0
    );
  };
  const corrected = profiled.filter((d) => hasCorrections(d.profile));
  const untouched = profiled.filter((d) => !hasCorrections(d.profile));

  return NextResponse.json({
    days,
    totals: {
      closed: deals.length,
      profiled: profiled.length,
      unprofiled: unprofiled.length,
      winRateProfiled: winRate(profiled),
      winRateUnprofiled: winRate(unprofiled),
      avgConfWon: avgConf(profiled.filter((d) => d.won)),
      avgConfLost: avgConf(profiled.filter((d) => !d.won)),
    },
    archetypes: [...byArch.entries()]
      .map(([key, e]) => ({
        key,
        name: e.name,
        closed: e.closed,
        won: e.won,
        winRate: e.closed ? e.won / e.closed : null,
        wonValueCents: e.wonValueCents,
        topLostReason: Object.entries(e.lostReasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      }))
      .sort((a, b) => b.closed - a.closed),
    calibration: buckets,
    corrections: {
      corrected: { n: corrected.length, won: corrected.filter((d) => d.won).length },
      untouched: { n: untouched.length, won: untouched.filter((d) => d.won).length },
    },
  });
}
