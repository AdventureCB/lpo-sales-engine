import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase";
import { gmailConfigured, sweepGmailAccount } from "@/lib/gmail";

export const runtime = "nodejs";
export const maxDuration = 60;

const BUDGET_MS = 45_000;

/** Sweep every connected mailbox into contact timelines (15-min pg_cron). */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!gmailConfigured()) return NextResponse.json({ ok: true, skipped: "not configured" });

  const db = supabaseAdmin();
  const { data: accounts } = await db.from("gmail_accounts").select("*").eq("status", "active");
  const started = Date.now();
  const results: Record<string, unknown>[] = [];
  for (const account of accounts ?? []) {
    const remaining = BUDGET_MS - (Date.now() - started);
    if (remaining < 5_000) break;
    try {
      const r = await sweepGmailAccount(db, account, remaining);
      results.push({ account: account.user_email, ...r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db
        .from("gmail_accounts")
        .update({ status: /invalid_grant/.test(msg) ? "error" : "active", last_error: msg.slice(0, 300) })
        .eq("user_email", account.user_email);
      results.push({ account: account.user_email, error: msg });
    }
  }
  return NextResponse.json({ ok: true, results });
}
