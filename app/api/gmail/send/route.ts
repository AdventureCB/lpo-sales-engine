import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { sendGmail } from "@/lib/gmail";
import { normalizeEmail } from "@/lib/identity";
import { linkifyHtml, linkifyPlain, hasRichLinks } from "@/lib/richtext";

export const runtime = "nodejs";

/** Send an email from the rep's connected Gmail; logs to the deal timeline. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { to?: string; subject?: string; body?: string; dealId?: string; contactId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const to = normalizeEmail(body.to ?? "");
  const subject = body.subject?.trim();
  const text = body.body?.trim();
  if (!to || !subject || !text) {
    return NextResponse.json({ error: "to, subject, body required" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: account } = await db
    .from("gmail_accounts")
    .select("*")
    .eq("user_email", user.email)
    .maybeSingle();
  if (!account?.refresh_token) {
    return NextResponse.json(
      { error: "Gmail not connected — use Connect Gmail in the sidebar first" },
      { status: 409 }
    );
  }

  let messageId: string;
  try {
    // Render asset markdown links to a real HTML hyperlink; keep a plain-text
    // alternative for clients that don't render HTML.
    const rich = hasRichLinks(text);
    messageId = await sendGmail(db, account, {
      to,
      subject,
      body: linkifyPlain(text),
      html: rich ? linkifyHtml(text) : undefined,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "send failed" },
      { status: 502 }
    );
  }

  // Timeline immediately; pd_key matches the sweep's dedupe key so the
  // 15-min Gmail sync won't double-log it.
  await db.from("crm_activities").insert({
    pd_key: `gmail:${account.google_email}:${messageId}`,
    deal_id: body.dealId ?? null,
    contact_id: body.contactId ?? null,
    type: "email",
    subject: `📤 ${subject}`,
    body: text.slice(0, 500),
    actor: user.email,
    occurred_at: new Date().toISOString(),
    meta: { gmail: true, direction: "outbound" },
  });

  return NextResponse.json({ ok: true, messageId });
}
