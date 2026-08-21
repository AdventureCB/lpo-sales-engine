import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rep interactions with a generated draft/script: used it, or thumbed it. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { draftId?: string; dealId?: string; kind?: string; action?: "used" | "thumbs"; thumbs?: "up" | "down"; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.action) return NextResponse.json({ error: "action required" }, { status: 400 });
  const db = supabaseAdmin();

  // No draftId happens for cache-hit call scripts (preloads don't ledger) —
  // a thumbs there creates the feedback row directly.
  if (!body.draftId) {
    if (body.action === "thumbs" && body.dealId && ["call", "email", "sms"].includes(body.kind ?? "")) {
      await db.from("draft_events").insert({
        deal_id: body.dealId,
        kind: body.kind,
        rep: user.repName ?? user.email,
        thumbs: body.thumbs === "up" ? "up" : "down",
        thumbs_note: (body.note ?? "").slice(0, 500) || null,
      });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "draftId (or dealId+kind for thumbs) required" }, { status: 400 });
  }

  const patch =
    body.action === "used"
      ? { used_at: new Date().toISOString() }
      : { thumbs: body.thumbs === "up" ? "up" : "down", thumbs_note: (body.note ?? "").slice(0, 500) || null };
  await db.from("draft_events").update(patch).eq("id", body.draftId);
  return NextResponse.json({ ok: true });
}
