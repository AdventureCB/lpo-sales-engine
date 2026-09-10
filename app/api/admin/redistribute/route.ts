import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Admin: round-robin redistribute a (departed) rep's open deals to chosen
 * eligible reps. GET = owners with open-deal counts; POST preview/execute.
 * Deals are interleaved by recency so each target gets an even mix of fresh
 * and old, and every reassigned deal gets a system timeline entry.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  const { data: reps } = await db
    .from("reps")
    .select("name, email, pipedrive_user_id, active")
    .not("pipedrive_user_id", "is", null);
  const owners: { id: number; name: string; active: boolean; openDeals: number }[] = [];
  for (const r of reps ?? []) {
    const { count } = await db
      .from("crm_deals")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")
      .eq("owner_pipedrive_id", r.pipedrive_user_id);
    owners.push({ id: r.pipedrive_user_id as number, name: r.name, active: !!r.active, openDeals: count ?? 0 });
  }
  const { count: poolCount } = await db
    .from("crm_deals")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
    .is("owner_pipedrive_id", null);
  return NextResponse.json({ owners: owners.sort((a, b) => b.openDeals - a.openDeals), poolCount: poolCount ?? 0 });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { fromOwnerId?: number; toOwnerIds?: number[]; execute?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const from = body.fromOwnerId;
  const targets = [...new Set((body.toOwnerIds ?? []).filter((n) => Number.isFinite(n)))];
  if (!from || targets.length === 0) return NextResponse.json({ error: "fromOwnerId and toOwnerIds required" }, { status: 400 });
  if (targets.includes(from)) return NextResponse.json({ error: "source can't be a target" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: repRows } = await db.from("reps").select("name, pipedrive_user_id").in("pipedrive_user_id", [from, ...targets]);
  const nameById = new Map((repRows ?? []).map((r) => [r.pipedrive_user_id as number, r.name as string]));
  for (const t of targets) {
    if (!nameById.has(t)) return NextResponse.json({ error: `unknown target owner ${t}` }, { status: 400 });
  }

  // Full open book, paged past the 1000-row cap; recency-ordered so the
  // round-robin interleave gives every target an even fresh/stale mix.
  const deals: { id: string; contact_id: string | null }[] = [];
  for (let fromIdx = 0; ; fromIdx += 1000) {
    const { data } = await db
      .from("crm_deals")
      .select("id, contact_id")
      .eq("status", "open")
      .eq("owner_pipedrive_id", from)
      .order("updated_at", { ascending: false })
      .range(fromIdx, fromIdx + 999);
    deals.push(...((data ?? []) as any[]));
    if (!data || data.length < 1000) break;
  }

  const perRep = new Map<number, { id: string; contact_id: string | null }[]>(targets.map((t) => [t, []]));
  deals.forEach((d, i) => perRep.get(targets[i % targets.length])!.push(d));
  const preview = targets.map((t) => ({ ownerId: t, name: nameById.get(t) ?? String(t), count: perRep.get(t)!.length }));

  if (!body.execute) return NextResponse.json({ total: deals.length, from: nameById.get(from) ?? String(from), preview });

  const fromName = nameById.get(from) ?? String(from);
  let updated = 0;
  for (const t of targets) {
    const mine = perRep.get(t)!;
    for (let i = 0; i < mine.length; i += 200) {
      const ids = mine.slice(i, i + 200).map((d) => d.id);
      const { error } = await db
        .from("crm_deals")
        .update({ owner_pipedrive_id: t, updated_at: new Date().toISOString() })
        .in("id", ids);
      if (!error) updated += ids.length;
    }
  }

  // Timeline trail on every deal (batched) — history keeps the old name.
  const nowIso = new Date().toISOString();
  const actRows = targets.flatMap((t) =>
    perRep.get(t)!.map((d) => ({
      deal_id: d.id,
      contact_id: d.contact_id,
      type: "system",
      subject: `🔀 Reassigned: ${fromName} → ${nameById.get(t)}`,
      body: `Round-robin redistribution by ${user.email}`,
      actor: user.email,
      occurred_at: nowIso,
    }))
  );
  for (let i = 0; i < actRows.length; i += 500) {
    await db.from("crm_activities").insert(actRows.slice(i, i + 500));
  }

  return NextResponse.json({ ok: true, total: deals.length, updated, preview });
}
