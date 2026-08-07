import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { generateAndSave, loadConfig, ListPrereqError } from "@/lib/sprint-lists";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function laToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const isCron = (req: NextRequest) => req.headers.get("authorization") === `Bearer ${env("CRON_SECRET")}`;

/**
 * Generate a daily Sprint List.
 * - Rep (session): slot 1|2 for themselves.
 * - Admin (session): slot 1|2|3 for any rep via ?repEmail.
 * - Cron (Bearer CRON_SECRET): slot for ALL active sales reps (list 3 @ 1pm).
 */
export async function POST(req: NextRequest) {
  const db = supabaseAdmin();
  const cfg = await loadConfig(db);
  const params = new URL(req.url).searchParams;
  const body = await req.json().catch(() => ({} as any));
  const slot = Number(body.slot ?? params.get("slot")) as 1 | 2 | 3;
  const forDate = (body.forDate ?? params.get("forDate") ?? laToday()) as string;
  if (![1, 2, 3].includes(slot)) return NextResponse.json({ error: "slot must be 1, 2 or 3" }, { status: 400 });

  // Cron path: fan out over every active sales rep.
  if (isCron(req)) {
    const { data: reps } = await db
      .from("reps")
      .select("email, pipedrive_user_id")
      .eq("active", true)
      .not("pipedrive_user_id", "is", null);
    const results: any[] = [];
    for (const r of reps ?? []) {
      try {
        const out = await generateAndSave(db, { repEmail: r.email!, repPipedriveId: r.pipedrive_user_id!, slot, forDate }, cfg);
        results.push({ rep: r.email, count: out.count, sprintId: out.sprintId });
      } catch (e) {
        results.push({ rep: r.email, error: e instanceof Error ? e.message : "failed" });
      }
    }
    return NextResponse.json({ ok: true, slot, forDate, results });
  }

  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Resolve target rep.
  let repEmail = user.email;
  let repPd = user.pipedriveUserId;
  const target = (body.repEmail ?? params.get("repEmail")) as string | undefined;
  if (target && target !== user.email) {
    if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
    const { data: r } = await db.from("reps").select("email, pipedrive_user_id").eq("email", target).maybeSingle();
    if (!r?.pipedrive_user_id) return NextResponse.json({ error: "rep not found / no pipedrive id" }, { status: 404 });
    repEmail = r.email!;
    repPd = r.pipedrive_user_id;
  }
  if (!repPd) return NextResponse.json({ error: "no pipedrive owner id for rep" }, { status: 400 });
  if (slot === 3 && user.role !== "admin") {
    // List 3 is normally cron-generated; allow admin manual trigger only.
    return NextResponse.json({ error: "list 3 auto-generates at 1pm" }, { status: 403 });
  }

  try {
    const out = await generateAndSave(db, { repEmail, repPipedriveId: repPd, slot, forDate }, cfg);
    return NextResponse.json({ ok: true, slot, forDate, sprintId: out.sprintId, count: out.count });
  } catch (e) {
    if (e instanceof ListPrereqError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("sprint-list generate failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
