import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Email marketing report from email_stats_monthly.
 *   ?from=YYYY-MM&to=YYYY-MM (inclusive months) &compare=1 → same months a year earlier.
 * Rates are recomputed from counts (unique opens ÷ delivered), never averaged.
 */
interface Row {
  month: string; kind: "campaign" | "flow"; entity_id: string; name: string | null; status: string | null; send_time: string | null;
  recipients: number; delivered: number; opens_unique: number; clicks_unique: number; bounced: number; unsubscribes: number; spam_complaints: number; conversions: number; conversion_value_cents: number;
}
const ym = (d: string) => d.slice(0, 7);
const addMonths = (m: string, n: number) => { const [y, mo] = m.split("-").map(Number); const t = y * 12 + mo - 1 + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };

function agg(rows: Row[]) {
  const t = { recipients: 0, delivered: 0, opens: 0, clicks: 0, bounced: 0, unsubscribes: 0, spam: 0, conversions: 0, revenueCents: 0, sends: 0 };
  for (const r of rows) {
    t.recipients += r.recipients; t.delivered += r.delivered; t.opens += r.opens_unique; t.clicks += r.clicks_unique;
    t.bounced += r.bounced; t.unsubscribes += r.unsubscribes; t.spam += r.spam_complaints; t.conversions += r.conversions; t.revenueCents += Number(r.conversion_value_cents);
  }
  const rate = (n: number, d: number) => (d > 0 ? n / d : null);
  return {
    ...t,
    openRate: rate(t.opens, t.delivered),
    clickRate: rate(t.clicks, t.delivered),
    ctor: rate(t.clicks, t.opens),
    unsubRate: rate(t.unsubscribes, t.delivered),
    bounceRate: rate(t.bounced, t.recipients),
    convRate: rate(t.conversions, t.delivered),
    rpr: t.delivered > 0 ? Math.round(t.revenueCents / t.delivered) : null,
  };
}

async function load(db: any, from: string, to: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from("email_stats_monthly").select("*").gte("month", `${from}-01`).lte("month", `${to}-01`).range(f, f + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

function report(rows: Row[], from: string, to: string) {
  const months: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) months.push(m);
  const byMonth = months.map((m) => {
    const mr = rows.filter((r) => ym(r.month) === m);
    return { month: m, all: agg(mr), campaigns: agg(mr.filter((r) => r.kind === "campaign")), flows: agg(mr.filter((r) => r.kind === "flow")) };
  });
  const group = (kind: "campaign" | "flow") => {
    const by = new Map<string, Row[]>();
    for (const r of rows) if (r.kind === kind) (by.get(r.entity_id) ?? by.set(r.entity_id, []).get(r.entity_id)!).push(r);
    return [...by.entries()].map(([id, rs]) => {
      const last = rs.reduce((a, b) => (a.month > b.month ? a : b));
      return { id, name: last.name ?? id, status: last.status, sendTime: last.send_time, firstMonth: rs.reduce((a, b) => (a.month < b.month ? a : b)).month.slice(0, 7), ...agg(rs) };
    });
  };
  return {
    from, to, months: byMonth,
    totals: { all: agg(rows), campaigns: agg(rows.filter((r) => r.kind === "campaign")), flows: agg(rows.filter((r) => r.kind === "flow")) },
    flows: group("flow").sort((a, b) => b.delivered - a.delivered),
    campaigns: group("campaign").sort((a, b) => (b.sendTime ?? b.firstMonth).localeCompare(a.sendTime ?? a.firstMonth)),
  };
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const p = new URL(req.url).searchParams;
  const ok = (s: string | null) => !!s && /^\d{4}-\d{2}$/.test(s);
  const now = new Date();
  const thisM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const to = ok(p.get("to")) ? p.get("to")! : thisM;
  const from = ok(p.get("from")) ? p.get("from")! : addMonths(to, -5);
  const compare = p.get("compare") !== "0";
  const db = supabaseAdmin();
  try {
    const cFrom = addMonths(from, -12), cTo = addMonths(to, -12);
    const [cur, prev, sync, cov] = await Promise.all([
      load(db, from, to),
      compare ? load(db, cFrom, cTo) : Promise.resolve([] as Row[]),
      db.from("crm_sync_state").select("value").eq("key", "email_stats_sync_refresh").maybeSingle(),
      db.from("email_stats_monthly").select("month").order("month", { ascending: true }).limit(1).maybeSingle(),
    ]);
    return NextResponse.json({
      a: report(cur, from, to),
      b: compare ? report(prev, cFrom, cTo) : null,
      coverageFrom: cov.data?.month ?? null,
      lastRefreshAt: (sync.data?.value as any)?.at ?? null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
