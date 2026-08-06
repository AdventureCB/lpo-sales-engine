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
    ? "crm_contacts!inner ( name, phones, tz_offset )"
    : "crm_contacts ( name, phones, tz_offset )";

  const db = supabaseAdmin();
  let q = db
    .from("crm_deals")
    .select(
      `id, title, status, value_cents, owner_pipedrive_id, stage_changed_at, last_activity_at, updated_at, pd_add_time, pipedrive_deal_id, crm_stages ( name, pipeline_id, crm_pipelines ( name ) ), ${contactEmbed}, deal_sources ( name )`,
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
  return NextResponse.json({ deals: data ?? [], total: count ?? 0, page, pageSize: PAGE_SIZE });
}
