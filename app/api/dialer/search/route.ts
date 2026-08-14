import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { normalizePhone } from "@/lib/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Global deal search over the CRM mirror (Pipedrive is a backup now).
 * Matches deal title OR contact name; also finds native, PD-less deals.
 * Anyone can FIND any deal; `callable` enforces the dialing rule — sales
 * may only call deals they own or deals not assigned to a sales rep.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const term = (new URL(req.url).searchParams.get("term") ?? "").trim();
  if (term.length < 2) return NextResponse.json({ results: [] });

  const db = supabaseAdmin();
  const like = `%${term.replace(/[%_]/g, "")}%`;
  const cols =
    "id, pipedrive_deal_id, title, status, owner_pipedrive_id, stage_id, updated_at, crm_stages ( name ), crm_contacts ( name, phones )";

  try {
    // Matching contacts by name → their deals; plus deals by title. Two small
    // reads merged and deduped keeps it a single round-trip each.
    const [{ data: byTitle }, { data: matchedContacts }] = await Promise.all([
      db.from("crm_deals").select(cols).ilike("title", like).limit(20),
      db.from("crm_contacts").select("id").ilike("name", like).limit(20),
    ]);

    let byContact: any[] = [];
    const contactIds = (matchedContacts ?? []).map((c: any) => c.id);
    if (contactIds.length) {
      const { data } = await db.from("crm_deals").select(cols).in("contact_id", contactIds).limit(30);
      byContact = data ?? [];
    }

    const { data: reps } = await db
      .from("reps")
      .select("pipedrive_user_id")
      .eq("active", true)
      .not("pipedrive_user_id", "is", null);
    const repIds = new Set((reps ?? []).map((r) => r.pipedrive_user_id as number));

    // Merge + dedupe by CRM id; open deals first, then most-recently updated.
    const seen = new Map<string, any>();
    for (const d of [...(byTitle ?? []), ...byContact]) if (!seen.has(d.id)) seen.set(d.id, d);
    const merged = [...seen.values()]
      .sort((a, b) => {
        if ((a.status === "open") !== (b.status === "open")) return a.status === "open" ? -1 : 1;
        return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
      })
      .slice(0, 20);

    const results = merged.map((d) => {
      const phones = ((d.crm_contacts?.phones as any[]) ?? []).filter((p) => !p.bad);
      const raw = phones.find((p) => p.primary && p.e164)?.e164 ?? phones.find((p) => p.e164)?.e164 ?? phones.find((p) => p.value)?.value ?? null;
      const phone = normalizePhone(raw);
      const owner = d.owner_pipedrive_id ?? null;
      const callable =
        user.role === "admin" ||
        owner === user.pipedriveUserId ||
        owner == null ||
        !repIds.has(owner);
      return {
        dealId: d.pipedrive_deal_id ?? 0,
        crmDealId: d.id,
        title: d.title,
        status: d.status,
        personName: d.crm_contacts?.name ?? null,
        phone,
        stageName: d.crm_stages?.name ?? "—",
        callable: callable && Boolean(phone),
        hot: false,
        hotReason: null,
      };
    });
    return NextResponse.json({ results });
  } catch (e) {
    console.error("deal search failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
