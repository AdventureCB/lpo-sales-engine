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
    ? "crm_contacts!inner ( name, phones, emails, tz_offset )"
    : "crm_contacts ( name, phones, emails, tz_offset )";

  const db = supabaseAdmin();
  let q = db
    .from("crm_deals")
    .select(
      `id, title, status, value_cents, owner_pipedrive_id, contact_id, stage_changed_at, last_activity_at, updated_at, pd_add_time, pipedrive_deal_id, truck_model, crm_stages ( name, pipeline_id, crm_pipelines ( name ) ), ${contactEmbed}, deal_sources ( name )`,
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
  const search = (p.get("q") ?? "").trim();
  if (search) q = q.ilike("title", `%${search.replace(/[%_]/g, "")}%`);

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
      emails.length
        ? db
            .from("klaviyo_events")
            .select("email, metric, event_at")
            .in("email", emails)
            .gte("event_at", sevenAgo)
            .filter("metric", "imatch", "(add.*cart|checkout started|started checkout|save.*build|3d builder)")
            .order("event_at", { ascending: false })
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
    const signalByEmail = new Map<string, { metric: string; at: string }>();
    for (const s of signals ?? []) {
      const key = (s.email ?? "").toLowerCase();
      if (!signalByEmail.has(key)) signalByEmail.set(key, { metric: s.metric, at: s.event_at });
    }

    for (const d of deals) {
      d.next_activity_at = nextByDeal.get(d.id) ?? (d.contact_id ? nextByContact.get(d.contact_id) : null) ?? null;
      const st = statByDeal.get(d.id) as any;
      d.dials = Number(st?.dials ?? 0);
      d.conversations = Number(st?.conversations ?? 0);
      const em = ((d.crm_contacts?.emails as any[]) ?? []).map((e) => (e.value ?? "").toLowerCase());
      d.buy_signal = em.map((e: string) => signalByEmail.get(e)).find(Boolean) ?? null;
    }
  }

  return NextResponse.json({ deals, total: count ?? 0, page, pageSize: PAGE_SIZE });
}
