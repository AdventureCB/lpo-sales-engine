import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Record one focus session in an external tool window (companion emits
 * focus/blur per tool window; the client closes sessions on blur). */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { tool?: string; focusedAt?: string; blurredAt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const tool = (body.tool ?? "").slice(0, 24);
  const f = Date.parse(body.focusedAt ?? "");
  const b = Date.parse(body.blurredAt ?? "");
  if (!tool || !Number.isFinite(f) || !Number.isFinite(b) || b <= f) {
    return NextResponse.json({ error: "tool, focusedAt, blurredAt required" }, { status: 400 });
  }
  const durationS = Math.round((b - f) / 1000);
  if (durationS < 3 || durationS > 12 * 3600) return NextResponse.json({ ok: true, skipped: "implausible duration" });
  const db = supabaseAdmin();
  await db.from("tool_sessions").insert({
    rep_email: user.email,
    tool,
    focused_at: new Date(f).toISOString(),
    blurred_at: new Date(b).toISOString(),
    duration_s: durationS,
  });
  return NextResponse.json({ ok: true });
}

/** Admin: per-rep per-tool totals for the last N days (default 7). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days") ?? 7) || 7, 1), 90);
  const db = supabaseAdmin();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await db
    .from("tool_sessions")
    .select("rep_email, tool, duration_s")
    .gte("focused_at", since)
    .limit(10000);
  const totals: Record<string, Record<string, number>> = {};
  for (const r of data ?? []) {
    totals[r.rep_email] ??= {};
    totals[r.rep_email][r.tool] = (totals[r.rep_email][r.tool] ?? 0) + r.duration_s;
  }
  return NextResponse.json({ days, totals });
}
