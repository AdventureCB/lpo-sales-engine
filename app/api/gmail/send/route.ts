import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { sendGmail } from "@/lib/gmail";
import { normalizeEmail } from "@/lib/identity";
import { hasRichLinks, isHtml, toEmailHtml, toPlainText } from "@/lib/richtext";

export const runtime = "nodejs";

/** Send an email from the rep's connected Gmail; logs to the deal timeline. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { to?: string; subject?: string; body?: string; dealId?: string; contactId?: string; attachmentAssetIds?: string[] };
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

  // Pull any media assets to attach from the comm-media bucket.
  const attachments: { filename: string; mimeType: string; dataBase64: string }[] = [];
  if (body.attachmentAssetIds?.length) {
    const { data: media } = await db
      .from("comm_assets")
      .select("name, url, mime_type")
      .eq("kind", "media")
      .in("id", body.attachmentAssetIds);
    for (const a of media ?? []) {
      const { data: file } = await db.storage.from("comm-media").download(a.url);
      if (!file) continue;
      const buf = Buffer.from(await file.arrayBuffer());
      attachments.push({ filename: a.name, mimeType: a.mime_type ?? "application/octet-stream", dataBase64: buf.toString("base64") });
    }
  }
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

  // Append the sender's saved signature to every email. Body and signature may
  // each be editor HTML or legacy plain text — compose both a plain-text
  // alternative and an HTML part from whichever they are.
  const { data: me } = await db.from("app_users").select("email_signature").eq("id", user.authUserId).maybeSingle();
  const sig = me?.email_signature?.trim();
  const bodyPlain = toPlainText(text);
  const fullPlain = sig ? `${bodyPlain}\n\n${toPlainText(sig)}` : bodyPlain;
  const fullHtml = toEmailHtml(text) + (sig ? `<br><br>${toEmailHtml(sig)}` : "");

  let messageId: string;
  try {
    const rich =
      isHtml(text) || hasRichLinks(text) || (!!sig && (isHtml(sig) || hasRichLinks(sig))) || attachments.length > 0;
    messageId = await sendGmail(db, account, {
      to,
      subject,
      body: fullPlain,
      html: rich ? fullHtml : undefined,
      attachments: attachments.length ? attachments : undefined,
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
    body: bodyPlain.slice(0, 500),
    actor: user.email,
    occurred_at: new Date().toISOString(),
    meta: { gmail: true, direction: "outbound" },
  });

  return NextResponse.json({ ok: true, messageId });
}
