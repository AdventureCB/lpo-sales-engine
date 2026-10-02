import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ambassador sales: monthly history (Collabs refs + roster codes), per-ambassador
 * totals for the selected window, the roster, and unassigned code candidates.
 *   GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD (window for the per-ambassador table)
 *   POST { action: "upsert", id?, name, codes[], refIds[], active, notes }
 *        { action: "delete", id }
 *        { action: "assign", code, ambassadorId? , name? }   // code → existing or new ambassador
 */
function laMidnight(d: string | null, dayOffset = 0): string | null {
  const m = (d ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3] + dayOffset, 8);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit" }).formatToParts(new Date(guess)).find((p) => p.type === "hour")?.value ?? 0) % 24;
  return new Date(guess - hour * 3_600_000).toISOString();
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const p = new URL(req.url).searchParams;
  const db = supabaseAdmin();
  const histFrom = new Date(Date.UTC(new Date().getUTCFullYear() - 2, new Date().getUTCMonth(), 1)).toISOString();
  const from = laMidnight(p.get("from"));
  const to = laMidnight(p.get("to"), 1);
  try {
    const [hist, roster, cands] = await Promise.all([
      db.rpc("ambassador_sales_by_month", { p_from: histFrom }),
      db.from("ambassadors").select("*").order("name"),
      db.rpc("ambassador_code_candidates", { p_from: histFrom }),
    ]);
    for (const r of [hist, roster, cands]) if (r.error) throw new Error(r.error.message);
    const rows = (hist.data ?? []) as any[];
    const months = new Map<string, { month: string; orders: number; netCents: number; discountCents: number; code: number; collabs: number }>();
    for (const r of rows) {
      const m = String(r.month).slice(0, 7);
      const cur = months.get(m) ?? { month: `${m}-01`, orders: 0, netCents: 0, discountCents: 0, code: 0, collabs: 0 };
      cur.orders += Number(r.orders); cur.netCents += Number(r.net_cents); cur.discountCents += Number(r.discount_cents);
      if (r.via === "code") cur.code += Number(r.net_cents);
      else cur.collabs += Number(r.net_cents);
      months.set(m, cur);
    }
    // Per-ambassador totals inside the page window (month granularity on the RPC → filter by month bounds).
    const fromM = from ? from.slice(0, 7) : null, toM = to ? new Date(Date.parse(to) - 1).toISOString().slice(0, 7) : null;
    const byAmb = new Map<string, { id: string | null; name: string; orders: number; netCents: number; discountCents: number; customers: number; viaCode: number; viaCollabs: number }>();
    for (const r of rows) {
      const m = String(r.month).slice(0, 7);
      if ((fromM && m < fromM) || (toM && m > toM)) continue;
      const key = r.ambassador_id ?? "__unmapped__";
      const cur = byAmb.get(key) ?? { id: r.ambassador_id, name: r.ambassador, orders: 0, netCents: 0, discountCents: 0, customers: 0, viaCode: 0, viaCollabs: 0 };
      cur.orders += Number(r.orders); cur.netCents += Number(r.net_cents); cur.discountCents += Number(r.discount_cents); cur.customers += Number(r.customers);
      if (r.via === "code") cur.viaCode += Number(r.orders); else cur.viaCollabs += Number(r.orders);
      byAmb.set(key, cur);
    }
    return NextResponse.json({
      months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
      ambassadors: [...byAmb.values()].sort((a, b) => b.netCents - a.netCents),
      roster: (roster.data ?? []).map((a: any) => ({ id: a.id, name: a.name, codes: a.codes ?? [], refIds: a.ref_ids ?? [], active: a.active, notes: a.notes })),
      candidates: ((cands.data ?? []) as any[]).map((c) => ({ code: c.code, orders: Number(c.orders), netCents: Number(c.net_cents), firstAt: c.first_at, lastAt: c.last_at, collabsOrders: Number(c.collabs_orders) })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const db = supabaseAdmin();
  const clean = (xs: unknown) => (Array.isArray(xs) ? xs.map((s) => String(s).trim()).filter(Boolean) : []);
  try {
    if (body.action === "delete" && body.id) {
      const { error } = await db.from("ambassadors").delete().eq("id", body.id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "assign" && body.code) {
      const code = String(body.code).trim();
      if (body.ambassadorId) {
        const { data: a, error } = await db.from("ambassadors").select("codes").eq("id", body.ambassadorId).single();
        if (error) throw new Error(error.message);
        const codes = Array.from(new Set([...(a.codes ?? []), code]));
        const { error: e2 } = await db.from("ambassadors").update({ codes, updated_at: new Date().toISOString() }).eq("id", body.ambassadorId);
        if (e2) throw new Error(e2.message);
        return NextResponse.json({ ok: true });
      }
      const name = String(body.name ?? "").trim() || code;
      const { error } = await db.from("ambassadors").insert({ name, codes: [code] });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "upsert") {
      const row = { name: String(body.name ?? "").trim(), codes: clean(body.codes), ref_ids: clean(body.refIds), active: body.active !== false, notes: body.notes ? String(body.notes) : null, updated_at: new Date().toISOString() };
      if (!row.name) return NextResponse.json({ error: "name required" }, { status: 400 });
      const q = body.id ? db.from("ambassadors").update(row).eq("id", body.id) : db.from("ambassadors").insert(row);
      const { error } = await q;
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
