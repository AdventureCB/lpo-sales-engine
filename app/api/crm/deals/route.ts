import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SORTS: Record<string, string> = {
  timezone: "crm_contacts(tz_offset)", // to-one embedded order (PostgREST 12+)
  updated: "updated_at",
  created: "pd_add_time",
  title: "title",
  value: "value_cents",
  activity: "last_activity_at",
  stage_changed: "stage_changed_at",
};

/** Deal browser over the mirrored CRM (all roles). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const p = new URL(req.url).searchParams;
  const page = Math.max(0, Number(p.get("page")) || 0);
  const sort = SORTS[p.get("sort") ?? "updated"] ?? "updated_at";
  const asc = p.get("dir") === "asc";
  const PAGE_SIZE = 50;

  // Filtering by timezone constrains the PARENT list, which needs an inner
  // join on the embedded contact (a plain embed leaves deals unfiltered).
  const tz = p.get("tz"); // west | central | east
  const contactEmbed = tz
    ? "crm_contacts!inner ( name, phones, emails, tz_offset, attribution )"
    : "crm_contacts ( name, phones, emails, tz_offset, attribution )";

  const db = supabaseAdmin();
  let q = db
    .from("crm_deals")
    .select(
      `id, title, status, value_cents, owner_pipedrive_id, contact_id, stage_changed_at, last_activity_at, updated_at, pd_add_time, pipedrive_deal_id, truck_model, interests, crm_stages ( name, pipeline_id, crm_pipelines ( name ) ), ${contactEmbed}, deal_sources ( name )`,
      { count: "exact" }
    );

  if (p.get("status")) q = q.eq("status", p.get("status"));
  if (p.get("stageId")) q = q.eq("stage_id", p.get("stageId"));
  if (p.get("owner")) q = q.eq("owner_pipedrive_id", Number(p.get("owner")));
  const source = p.get("source");
  if (source === "none") q = q.is("source_id", null);
  else if (source) q = q.eq("source_id", source);
  // West ≤ −7, Central = −6, East ≥ −5 (offsets are contiguous by region).
  if (tz === "west") q = q.lte("crm_contacts.tz_offset", -7);
  else if (tz === "central") q = q.eq("crm_contacts.tz_offset", -6);
  else if (tz === "east") q = q.gte("crm_contacts.tz_offset", -5);

  // ── Advanced filters ──
  const hasAct = p.get("hasActivity"); // "yes" | "no"
  if (hasAct === "yes") q = q.not("last_activity_at", "is", null);
  else if (hasAct === "no") q = q.is("last_activity_at", null);
  if (p.get("activityAfter")) q = q.gte("last_activity_at", p.get("activityAfter")!);
  if (p.get("activityBefore")) q = q.lte("last_activity_at", p.get("activityBefore")!);
  const make = p.get("make");
  if (make) q = q.ilike("truck_model", `${make.replace(/[%_]/g, "")}%`);
  const interests = (p.get("interests") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (interests.length) q = q.overlaps("interests", interests);
  if (p.get("valueMin")) q = q.gte("value_cents", Math.round(Number(p.get("valueMin")) * 100));
  if (p.get("valueMax")) q = q.lte("value_cents", Math.round(Number(p.get("valueMax")) * 100));

  // Search matches the trigger-maintained search_blob (migration 00090):
  // title + contact name + emails + phone digits + source name. Words AND
  // together; phone-looking words collapse to digits (last 10, matching
  // contact_phone_set's normalization).
  const search = (p.get("q") ?? "").trim();
  if (search) {
    const words = search
      .split(/\s+/)
      .map((w) => (/^[+\d][\d\s\-().]*$/.test(w) ? w.replace(/\D/g, "").slice(-10) : w.replace(/[%_]/g, "")))
      .filter(Boolean);
    for (const w of words) q = q.ilike("search_blob", `%${w}%`);
  }

  const { data, count, error } = await q
    .order(sort, { ascending: asc, nullsFirst: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  if (error) {
    console.error("crm deals query failed", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  // ── Enrich the page: next activity, call stats, buy signal ──
  const deals = (data ?? []) as any[];
  const dealIds = deals.map((d) => d.id);
  const contactIds = [...new Set(deals.map((d) => d.contact_id).filter(Boolean))];
  const emails = [
    ...new Set(
      deals.flatMap((d) => ((d.crm_contacts?.emails as any[]) ?? []).map((e) => (e.value ?? "").toLowerCase()).filter(Boolean))
    ),
  ];

  if (dealIds.length > 0) {
    const nowIso = new Date().toISOString();
    const sevenAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [{ data: nextActs }, { data: callStats }, { data: signals }] = await Promise.all([
      // Soonest pending (undone) scheduled activity per deal/contact.
      db
        .from("crm_activities")
        .select("deal_id, contact_id, due_at")
        .not("due_at", "is", null)
        .is("done_at", null)
        .or(`deal_id.in.(${dealIds.join(",")})${contactIds.length ? `,contact_id.in.(${contactIds.join(",")})` : ""}`)
        .order("due_at"),
      db.rpc("deals_call_stats", { p_deals: dealIds }),
      // Buy signal reads engagement_events (broad — the hot-list cron sweeps
      // it), NOT klaviyo_events (only synced on page-view, ~16 contacts).
      // Buy-intent types are Shopify-sourced: checkout_started, builder_save.
      emails.length
        ? db
            .from("engagement_events")
            .select("person_email, type, occurred_at")
            .in("person_email", emails)
            .gte("occurred_at", sevenAgo)
            .filter("type", "imatch", "(cart|checkout|builder_save|save.?build|abandon|3d)")
            .order("occurred_at", { ascending: false })
        : Promise.resolve({ data: [] as any[] }),
    ]);

    // next activity: earliest due per deal (deal-linked wins, else contact-linked)
    const nextByDeal = new Map<string, string>();
    const nextByContact = new Map<string, string>();
    for (const a of nextActs ?? []) {
      if (a.deal_id && !nextByDeal.has(a.deal_id)) nextByDeal.set(a.deal_id, a.due_at);
      if (a.contact_id && !nextByContact.has(a.contact_id)) nextByContact.set(a.contact_id, a.due_at);
    }
    const statByDeal = new Map((callStats ?? []).map((s: any) => [s.deal_id, s]));
    const prettyMetric = (t: string) =>
      ({ checkout_started: "Checkout started", builder_save: "Saved build", added_to_cart: "Added to cart" } as Record<string, string>)[t] ??
      t.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    const signalByEmail = new Map<string, { metric: string; at: string }>();
    for (const s of signals ?? []) {
      const key = (s.person_email ?? "").toLowerCase();
      if (!signalByEmail.has(key)) signalByEmail.set(key, { metric: prettyMetric(s.type), at: s.occurred_at });
    }

    // Ad source + estimated lead cost (channel CPL, cached 10 min).
    let cpl: Map<string, number | null> | null = null;
    try {
      const { cachedLeadCost } = await import("@/lib/lead-cost");
      const report = await cachedLeadCost(db, 30);
      cpl = new Map(report.channels.map((c) => [c.channel, c.cplCents]));
    } catch {}
    const { contactAdInfo } = await import("@/lib/lead-cost");

    for (const d of deals) {
      d.next_activity_at = nextByDeal.get(d.id) ?? (d.contact_id ? nextByContact.get(d.contact_id) : null) ?? null;
      const st = statByDeal.get(d.id) as any;
      d.dials = Number(st?.dials ?? 0);
      d.conversations = Number(st?.conversations ?? 0);
      const em = ((d.crm_contacts?.emails as any[]) ?? []).map((e) => (e.value ?? "").toLowerCase());
      d.buy_signal = em.map((e: string) => signalByEmail.get(e)).find(Boolean) ?? null;
      const ad = contactAdInfo(d.crm_contacts?.attribution);
      d.ad_source = ad.source;
      d.ad_channel = ad.channel;
      d.lead_cost_cents = ad.channel && cpl ? cpl.get(ad.channel) ?? null : null;
    }
  }

  return NextResponse.json({ deals, total: count ?? 0, page, pageSize: PAGE_SIZE });
}
