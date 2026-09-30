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

  const growth = [3, 6, 12].includes(Number(p.get("growth"))) ? Number(p.get("growth")) : 6;

  try {
    const [a, b, oldest, goal] = await Promise.all([
      run(from, to),
      run(cfrom, cto),
      db.from("shop_orders").select("created_at").order("created_at", { ascending: true }).limit(1).maybeSingle(),
      bucket === "month" && from && to ? seasonalGoal(run, p.get("from")!, p.get("to")!, growth) : Promise.resolve(null),
    ]);
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

/**
 * Seasonal goal line (month buckets only): for each month M from the period
 * start through HORIZON months past its end,
 *   goal(M) = net(M − 12) × [ Σ net(M−1 … M−w) ÷ Σ net(M−13 … M−12−w) ]
 * i.e. last year's month, scaled by the trailing-w-month year-over-year
 * growth as it stood going into M. Same collection filters as the report.
 */
async function seasonalGoal(run: (f: string | null, t: string | null) => Promise<any>, fromDay: string, toDay: string, w: number) {
  const first = monthStart(fromDay);
  const lastGoal = addMonths(monthStart(toDay), HORIZON);
  const histFrom = addMonths(first, -(12 + w));
  const rep = await run(laMidnight(histFrom), laMidnight(addMonths(lastGoal, 1)));
  const net = new Map<string, number>();
  for (const s of rep?.series ?? []) net.set(monthStart(s.bucket), Number(s.net) || 0);
  const at = (ym: string) => net.get(ym) ?? 0;
  const months: { bucket: string; goal: number | null; lastYear: number; ratio: number | null; future: boolean }[] = [];
  const endActual = monthStart(toDay);
  for (let ym = first; ym <= lastGoal; ym = addMonths(ym, 1)) {
    let cur = 0;
    let prior = 0;
    for (let k = 1; k <= w; k++) {
      cur += at(addMonths(ym, -k));
      prior += at(addMonths(ym, -12 - k));
    }
    const ratio = prior > 0 ? cur / prior : null;
    const ly = at(addMonths(ym, -12));
    months.push({ bucket: ym, lastYear: ly, ratio, goal: ratio != null && ly > 0 ? Math.round(ly * ratio) : null, future: ym > endActual });
  }
  return { window: w, horizon: HORIZON, months };
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
