import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { sendGmail } from "@/lib/gmail";
import { normalizeEmail } from "@/lib/identity";
import { toEmailHtml, toPlainText } from "@/lib/richtext";

export const runtime = "nodejs";

/** Send an email from the rep's connected Gmail; logs to the deal timeline. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    to?: string;
    subject?: string;
    body?: string;
    dealId?: string;
    contactId?: string;
    attachmentAssetIds?: string[];
    replyToActivityId?: string;
  };
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
  let fullHtml = toEmailHtml(text) + (sig ? `<br><br>${toEmailHtml(sig)}` : "");

  // ── Reply threading: the original message's id lives inside the synced
  // activity's pd_key (gmail:<account>:<gmail message id>). RFC headers
  // thread it for the RECIPIENT regardless of which rep replies; Gmail's
  // threadId only applies when the replier owns the mailbox it came from.
  let threadId: string | null = null;
  let inReplyTo: string | null = null;
  let references: string | null = null;
  if (body.replyToActivityId) {
    const { data: srcAct } = await db
      .from("crm_activities")
      .select("pd_key")
      .eq("id", body.replyToActivityId)
      .maybeSingle();
    const m = /^gmail:([^:]+):(.+)$/.exec(srcAct?.pd_key ?? "");
    if (m) {
      const { data: srcAccount } = await db.from("gmail_accounts").select("*").eq("google_email", m[1]).maybeSingle();
      if (srcAccount?.refresh_token) {
        const { getMessageThreadMeta } = await import("@/lib/gmail");
        const meta = await getMessageThreadMeta(db, srcAccount, m[2]);
        if (meta) {
          inReplyTo = meta.rfcMessageId;
          references = [meta.references, meta.rfcMessageId].filter(Boolean).join(" ") || null;
          if (srcAccount.google_email === account.google_email) threadId = meta.threadId;
        }
      }
    }
  }

  // ── Open/click tracking: pixel + per-link redirect, keyed by a token
  // created for this send. Links are stored by index (no open redirect).
  const APP = "https://lpo-sales-engine.vercel.app";
  const trackToken = crypto.randomUUID();
  const trackedLinks: string[] = [];
  fullHtml = fullHtml.replace(/href="(https?:\/\/[^"]+)"/gi, (full, url) => {
    if (url.startsWith(APP)) return full; // never rewrite our own links
    const i = trackedLinks.length;
    if (i >= 200) return full;
    trackedLinks.push(url);
    return `href="${APP}/api/track/c/${trackToken}?i=${i}"`;
  });
  fullHtml += `<img src="${APP}/api/track/o/${trackToken}" width="1" height="1" alt="" style="display:none">`;

  let messageId: string;
  try {
    messageId = await sendGmail(db, account, {
      to,
      subject,
      body: fullPlain,
      html: fullHtml, // tracking pixel requires the HTML part on every send
      attachments: attachments.length ? attachments : undefined,
      threadId,
      inReplyTo,
      references,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "send failed" },
      { status: 502 }
    );
  }

  // Timeline immediately; pd_key matches the sweep's dedupe key so the
  // 15-min Gmail sync won't double-log it.
  const { data: act } = await db
    .from("crm_activities")
    .insert({
      pd_key: `gmail:${account.google_email}:${messageId}`,
      deal_id: body.dealId ?? null,
      contact_id: body.contactId ?? null,
      type: "email",
      subject: `📤 ${subject}`,
      body: bodyPlain.slice(0, 50_000),
      actor: user.email,
      occurred_at: new Date().toISOString(),
      meta: { gmail: true, direction: "outbound" },
    })
    .select("id")
    .single();

  await db.from("email_tracking").insert({
    token: trackToken,
    activity_id: act?.id ?? null,
    deal_id: body.dealId ?? null,
    rep_email: user.email,
    to_email: to,
    subject,
    links: trackedLinks,
  });

  // Feedback loop: tie this send back to the AI draft the rep used (if any)
  // and score how much it was edited. Best-effort.
  if (body.dealId) {
    const { linkDraftToSend } = await import("@/lib/ai-scripts");
    await linkDraftToSend(db, body.dealId, "email", act?.id ?? null, bodyPlain);
  }

  return NextResponse.json({ ok: true, messageId });
}
