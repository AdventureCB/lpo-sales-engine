import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { readState, syncShopOrders, syncShopCatalog } from "@/lib/shop-orders-sync";
import { shopifyAdminConfigured } from "@/lib/shopify-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUCKETS = new Set(["day", "week", "month"]);

/** YYYY-MM-DD (LA-local calendar day) → ISO instant of that day's LA midnight (+dayOffset days). */
function laMidnight(d: string | null, dayOffset = 0): string | null {
  const m = (d ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3] + dayOffset, 8); // 08:00Z ≈ LA midnight/01:00
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit" });
  const hour = Number(fmt.formatToParts(new Date(guess)).find((p) => p.type === "hour")?.value ?? 0) % 24;
  return new Date(guess - hour * 3_600_000).toISOString();
}

/**
 * Admin revenue report: period A (from/to) vs period B (cfrom/cto). Dates are
 * LA-local calendar days, `to` inclusive. ?collections=id,id (empty = none)
 * &unmatched=0|1 &threshold=<cents> &bucket=day|week|month
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const p = new URL(req.url).searchParams;
  const db = supabaseAdmin();

  const from = laMidnight(p.get("from"));
  const to = laMidnight(p.get("to"), 1);
  const cfrom = laMidnight(p.get("cfrom"));
  const cto = laMidnight(p.get("cto"), 1);
  const bucket = BUCKETS.has(p.get("bucket") ?? "") ? (p.get("bucket") as string) : "month";
  const threshold = Math.max(0, Math.round(Number(p.get("threshold") ?? 500000) || 500000));
  const unmatched = p.get("unmatched") !== "0";
  const colParam = p.get("collections");
  const collections = colParam == null ? null : colParam.split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);

  const [{ data: cols }, state, counts] = await Promise.all([
    db.from("shop_collections").select("id, title, handle, products_count, rule_based").order("title"),
    readState(db),
    db.from("shop_orders").select("id", { count: "exact", head: true }),
  ]);
  const allIds = (cols ?? []).map((c: any) => Number(c.id));
  const selected = collections ?? allIds;

  const run = async (f: string | null, t: string | null) => {
    if (!f || !t) return null;
    const { data, error } = await db.rpc("shop_revenue_report", {
      p_from: f,
      p_to: t,
      p_collections: selected,
      p_include_unmatched: unmatched,
      p_threshold_cents: threshold,
      p_bucket: bucket,
    });
    if (error) throw new Error(error.message);
    return data;
  };

  try {
    const [a, b, oldest] = await Promise.all([
      run(from, to),
      run(cfrom, cto),
      db.from("shop_orders").select("created_at").order("created_at", { ascending: true }).limit(1).maybeSingle(),
    ]);
    const goal =
      bucket === "month" && a && b && from && to && cfrom && cto
        ? await seasonalGoal(run, { from: p.get("from")!, to: p.get("to")!, cfrom: p.get("cfrom")!, cto: p.get("cto")! }, a, b)
        : null;
    return NextResponse.json({
      a,
      b,
      goal,
      bucket,
      threshold,
      collections: cols ?? [],
      selected,
      unmatched,
      sync: {
        ...state,
        orders: counts.count ?? 0,
        oldestOrderAt: oldest.data?.created_at ?? null,
        configured: shopifyAdminConfigured(),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

const HORIZON = 3;
const monthStart = (d: string) => d.slice(0, 7) + "-01";
function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
}

const addYearsDay = (d: string, n: number) => `${Number(d.slice(0, 4)) + n}${d.slice(4)}`;

/**
 * Goal lines (month buckets only), always driven by the selector dates:
 *   growth  = period net ÷ compare net
 *   goal(M) = net(M − 12) × growth                       (green)
 *   normalized(M) = avg(net(M−12), net(M−24)) × growth2  (yellow)
 *     growth2 = period net ÷ avg(compare net, compare-a-year-earlier net)
 * The normalized line halves one-off spikes (e.g. Dec 2025) and treats a
 * product launch as a level shift over two years rather than one.
 * Both run from the period start through HORIZON months past its end.
 */
async function seasonalGoal(
  run: (f: string | null, t: string | null) => Promise<any>,
  d: { from: string; to: string; cfrom: string; cto: string },
  a: any,
  b: any
) {
  const first = monthStart(d.from);
  const lastGoal = addMonths(monthStart(d.to), HORIZON);
  const [hist, b2] = await Promise.all([
    run(laMidnight(addMonths(first, -24)), laMidnight(addMonths(lastGoal, 1))),
    run(laMidnight(addYearsDay(d.cfrom, -1)), laMidnight(addYearsDay(d.cto, -1), 1)),
  ]);
  const net = new Map<string, number>();
  for (const s of hist?.series ?? []) net.set(monthStart(s.bucket), Number(s.net) || 0);
  const has = (ym: string) => net.has(ym);
  const at = (ym: string) => net.get(ym) ?? 0;

  const aNet = Number(a?.totals?.net) || 0;
  const bNet = Number(b?.totals?.net) || 0;
  const b2Net = Number(b2?.totals?.net) || 0;
  const ratio = bNet > 0 ? aNet / bNet : null;
  // Normalized line: plain average of the month one and two years ago, times
  // the SAME growth multiplier as the green line. Kyle's read of the data is
  // that the two prior years track each other in absolute terms apart from
  // one-off months (Dec 2025), so averaging halves a spike without a second
  // ratio to explain. (A rescaled variant was tried and rejected: mid-year
  // growth of 2× does not describe Q4, where the two years were flat.)
  const scale: number | null = null;

  const endActual = monthStart(d.to);
  const months = [] as {
    bucket: string; future: boolean;
    lastYear: number; goal: number | null;
    twoYearsAgo: number | null; twoYearsAgoScaled: number | null; base2: number; normalized: number | null;
  }[];
  for (let ym = first; ym <= lastGoal; ym = addMonths(ym, 1)) {
    const ly = at(addMonths(ym, -12));
    const y2 = has(addMonths(ym, -24)) ? at(addMonths(ym, -24)) : null;
    const y2s = y2 != null ? (scale != null ? y2 * scale : y2) : null;
    const base2 = y2s != null ? (ly + y2s) / 2 : ly;
    months.push({
      bucket: ym,
      future: ym > endActual,
      lastYear: ly,
      goal: ratio != null && ly > 0 ? Math.round(ly * ratio) : null,
      twoYearsAgo: y2,
      twoYearsAgoScaled: y2s != null ? Math.round(y2s) : null,
      base2: Math.round(base2),
      normalized: ratio != null && base2 > 0 ? Math.round(base2 * ratio) : null,
    });
  }
  return {
    horizon: HORIZON,
    ratio,
    scale,
    periodNet: aNet,
    compareNet: bNet,
    compare2Net: b2Net,
    compare2From: addYearsDay(d.cfrom, -1),
    compare2To: addYearsDay(d.cto, -1),
    months,
  };
}

/** Admin "Sync now": one incremental pass (or ?what=catalog / ?what=full). */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  if (!shopifyAdminConfigured()) return NextResponse.json({ error: "Shopify Admin API not configured" }, { status: 400 });
  const what = new URL(req.url).searchParams.get("what") ?? "incremental";
  const db = supabaseAdmin();
  try {
    if (what === "catalog") return NextResponse.json(await syncShopCatalog(db));
    const res = await syncShopOrders(db, { mode: what === "full" ? "full" : "incremental", deadlineMs: 40_000 });
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
