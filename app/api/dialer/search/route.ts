import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { searchDeals, getPersonsByIds } from "@/lib/pipedrive";
import { normalizePhone } from "@/lib/identity";
import { STAGE_NAMES } from "@/lib/dialer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Global deal search. Anyone can FIND any deal; `callable` enforces the
 * dialing rule — sales may only call deals they own or deals not assigned
 * to a sales rep.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const term = (new URL(req.url).searchParams.get("term") ?? "").trim();
  if (term.length < 2) return NextResponse.json({ results: [] });

  try {
    const hits = await searchDeals(term);
    const personIds = [...new Set(hits.map((h) => h.person_id).filter((x): x is number => !!x))];
    const persons = await getPersonsByIds(personIds);

    const db = supabaseAdmin();
    const { data: reps } = await db
      .from("reps")
      .select("pipedrive_user_id")
      .eq("active", true)
      .not("pipedrive_user_id", "is", null);
    const repIds = new Set((reps ?? []).map((r) => r.pipedrive_user_id as number));

    const results = hits.map((h) => {
      const person = h.person_id ? persons.get(h.person_id) : undefined;
      const phone = normalizePhone(person?.phone);
      const callable =
        user.role === "admin" ||
        h.owner_id === user.pipedriveUserId ||
        (h.owner_id !== null && !repIds.has(h.owner_id));
      return {
        dealId: h.id,
        title: h.title,
        status: h.status,
        personName: person?.name ?? h.person_name,
        phone,
        stageName: h.stage_id ? STAGE_NAMES[h.stage_id] ?? `Stage ${h.stage_id}` : "—",
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
