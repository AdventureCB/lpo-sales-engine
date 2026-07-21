import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDealNotes } from "@/lib/pipedrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lazy lead-card detail: recent notes for the deal being viewed. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dealId = Number(new URL(req.url).searchParams.get("dealId"));
  if (!Number.isFinite(dealId)) {
    return NextResponse.json({ error: "dealId required" }, { status: 400 });
  }
  try {
    const notes = await getDealNotes(dealId);
    return NextResponse.json({ notes });
  } catch (e) {
    console.error("lead detail failed", e);
    return NextResponse.json({ notes: [] });
  }
}
