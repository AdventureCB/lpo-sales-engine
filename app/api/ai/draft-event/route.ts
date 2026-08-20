import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rep interactions with a generated draft: used it, or thumbed it. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { draftId?: string; action?: "used" | "thumbs"; thumbs?: "up" | "down"; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.draftId || !body.action) return NextResponse.json({ error: "draftId and action required" }, { status: 400 });
  const patch =
    body.action === "used"
      ? { used_at: new Date().toISOString() }
      : { thumbs: body.thumbs === "up" ? "up" : "down", thumbs_note: (body.note ?? "").slice(0, 500) || null };
  await supabaseAdmin().from("draft_events").update(patch).eq("id", body.draftId);
  return NextResponse.json({ ok: true });
}
