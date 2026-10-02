import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Website traffic report from the web_traffic_* cache.
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive) &cfrom=&cto= (compare window)
 * Daily series, totals, sources and devices are exact for the window; landing
 * pages are summed over the WEEKS that overlap the window (week granularity).
 */
interface Daily { day: string; sessions: number; visitors: number; pageviews: number; atc: number; reached_checkout: number; completed_checkout: number }
const isDay = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const addYears = (d: string, n: number) => `${Number(d.slice(0, 4)) + n}${d.slice(4)}`;
const monday = (d: string) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };

async function all(q: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await q().range(f, f + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

function totals(rows: Daily[]) {
  const t = rows.reduce((s, r) => ({ sessions: s.sessions + r.sessions, visitors: s.visitors + r.visitors, pageviews: s.pageviews + r.pageviews, atc: s.atc + r.atc, reached: s.reached + r.reached_checkout, completed: s.completed + r.completed_checkout }), { sessions: 0, visitors: 0, pageviews: 0, atc: 0, reached: 0, completed: 0 });
  const rate = (a: number, b: number) => (b > 0 ? a / b : null);
  return { ...t, days: rows.length, atcRate: rate(t.atc, t.sessions), checkoutRate: rate(t.reached, t.sessions), convRate: rate(t.completed, t.sessions), pvPerSession: rate(t.pageviews, t.sessions) };
}

async function period(db: any, from: string, to: string) {
  const [daily, sources, devices, pages] = await Promise.all([
    all(() => db.from("web_traffic_daily").select("*").gte("day", from).lte("day", to).order("day")),
    all(() => db.from("web_traffic_sources").select("day, source, name, sessions, atc, completed_checkout").gte("day", from).lte("day", to)),
    all(() => db.from("web_traffic_devices").select("day, device, sessions").gte("day", from).lte("day", to)),
    all(() => db.from("web_traffic_pages").select("week, path, sessions, atc, completed_checkout").gte("week", monday(from)).lte("week", to)),
  ]);
  const group = <T extends { sessions: number }>(rows: any[], key: (r: any) => string, extra: (acc: any, r: any) => void) => {
    const m = new Map<string, any>();
    for (const r of rows) { const k = key(r); const a = m.get(k) ?? { key: k, sessions: 0, atc: 0, completed: 0 }; a.sessions += r.sessions; extra(a, r); m.set(k, a); }
    return [...m.values()].sort((a, b) => b.sessions - a.sessions);
  };
  const addConv = (a: any, r: any) => { a.atc += r.atc ?? 0; a.completed += r.completed_checkout ?? 0; };
  const weeks = [...new Set(pages.map((p: any) => p.week))].sort();
  return {
    from, to,
    totals: totals(daily as Daily[]),
    daily: (daily as Daily[]).map((r) => ({ day: r.day, sessions: r.sessions, visitors: r.visitors, atc: r.atc, completed: r.completed_checkout })),
    sources: group(sources, (r) => r.source || "unknown", addConv),
    referrers: group(sources, (r) => r.name || "(direct / none)", addConv).slice(0, 25),
    devices: group(devices, (r) => r.device || "unknown", () => {}),
    pages: group(pages, (r) => r.path, addConv).slice(0, 300),
    pageWeeks: { count: weeks.length, from: weeks[0] ?? null, to: weeks[weeks.length - 1] ?? null },
  };
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const p = new URL(req.url).searchParams;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const to = isDay(p.get("to")) ? p.get("to")! : addDays(today, -1);
  const from = isDay(p.get("from")) ? p.get("from")! : addDays(to, -29);
  const cfrom = isDay(p.get("cfrom")) ? p.get("cfrom")! : addYears(from, -1);
  const cto = isDay(p.get("cto")) ? p.get("cto")! : addYears(to, -1);
  const db = supabaseAdmin();
  try {
    const [a, b, cov, sync] = await Promise.all([
      period(db, from, to),
      period(db, cfrom, cto),
      db.from("web_traffic_daily").select("day").order("day", { ascending: true }).limit(1).maybeSingle(),
      db.from("crm_sync_state").select("value").eq("key", "web_traffic_sync").maybeSingle(),
    ]);
    const latest = await db.from("web_traffic_daily").select("day").order("day", { ascending: false }).limit(1).maybeSingle();
    return NextResponse.json({ a, b, coverageFrom: cov.data?.day ?? null, coverageTo: latest.data?.day ?? null, sync: sync.data?.value ?? null });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
