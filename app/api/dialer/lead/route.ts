import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDealNotes, getDealActivities } from "@/lib/pipedrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lazy lead-card detail: recent notes + last activities for the deal. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dealId = Number(new URL(req.url).searchParams.get("dealId"));
  if (!Number.isFinite(dealId)) {
    return NextResponse.json({ error: "dealId required" }, { status: 400 });
  }
  try {
    const [notes, activities] = await Promise.all([
      getDealNotes(dealId),
      getDealActivities(dealId, 3),
    ]);
    return NextResponse.json({ notes, activities });
  } catch (e) {
    console.error("lead detail failed", e);
    return NextResponse.json({ notes: [], activities: [] });
  }
}
