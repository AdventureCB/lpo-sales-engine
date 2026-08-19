import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { getSessionUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { summarizeAssetLinks } from "@/lib/ai-scripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Warm-up pass for the drafts engine: pre-summarize URL assets' link
 * summaries (normally done lazily, 5 per generation) so the first rep draft
 * doesn't pay the fetch latency. Budget-bounded; call until remaining=0.
 * Admin or cron.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!isAuthorizedCron(req) && user?.role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = supabaseAdmin();
  const started = Date.now();
  let rounds = 0;

  const remainingCount = async () => {
    const { data } = await db.from("comm_assets").select("id, url, link_summary_src").eq("kind", "url");
    return (data ?? []).filter((a: any) => a.url && a.link_summary_src !== a.url).length;
  };

  let remaining = await remainingCount();
  while (remaining > 0 && Date.now() - started < 42_000) {
    await summarizeAssetLinks(db);
    rounds++;
    const after = await remainingCount();
    if (after >= remaining) break; // no progress (errors) — stop, retry later
    remaining = after;
  }
  return NextResponse.json({ ok: true, remaining, rounds });
}
