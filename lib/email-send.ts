import type { SupabaseClient } from "@supabase/supabase-js";
import { sendGmail } from "./gmail";
import { toEmailHtml, toPlainText } from "./richtext";

const APP = "https://lpo-sales-engine.vercel.app";

/**
 * Send an email from a rep's connected Gmail with open/click tracking and a
 * timeline entry — the same behavior as POST /api/gmail/send, callable from
 * server code (campaign sends run from a cron, not a browser).
 */
export async function sendTrackedEmail(
  db: SupabaseClient,
  opts: {
    actorEmail: string; // app user whose Gmail sends (must be connected)
    to: string;
    subject: string;
    body: string; // plain text or our rich-text markup
    dealId: string | null;
    contactId: string | null;
    meta?: Record<string, unknown>; // merged into the activity's meta
    threadId?: string | null;
    inReplyTo?: string | null;
    references?: string | null;
  }
): Promise<{ messageId: string; activityId: string | null; trackToken: string }> {
  const { data: account } = await db.from("gmail_accounts").select("*").eq("user_email", opts.actorEmail).maybeSingle();
  if (!account?.refresh_token) throw new Error(`Gmail not connected for ${opts.actorEmail}`);

  const bodyPlain = toPlainText(opts.body);
  let html = toEmailHtml(opts.body);
  const trackToken = crypto.randomUUID();
  const trackedLinks: string[] = [];
  html = html.replace(/href="(https?:\/\/[^"]+)"/gi, (full, url) => {
    if (url.startsWith(APP)) return full;
    const i = trackedLinks.length;
    if (i >= 200) return full;
    trackedLinks.push(url);
    return `href="${APP}/api/track/c/${trackToken}?i=${i}"`;
  });
  html += `<img src="${APP}/api/track/o/${trackToken}" width="1" height="1" alt="" style="display:none">`;

  const messageId = await sendGmail(db, account, {
    to: opts.to,
    subject: opts.subject,
    body: bodyPlain,
    html,
    threadId: opts.threadId ?? null,
    inReplyTo: opts.inReplyTo ?? null,
    references: opts.references ?? null,
  });

  const { data: act } = await db
    .from("crm_activities")
    .insert({
      pd_key: `gmail:${account.google_email}:${messageId}`,
      deal_id: opts.dealId,
      contact_id: opts.contactId,
      type: "email",
      subject: `📤 ${opts.subject}`,
      body: bodyPlain.slice(0, 50_000),
      actor: opts.actorEmail,
      occurred_at: new Date().toISOString(),
      meta: { gmail: true, direction: "outbound", ...(opts.meta ?? {}) },
    })
    .select("id")
    .single();

  await db.from("email_tracking").insert({
    token: trackToken,
    activity_id: act?.id ?? null,
    deal_id: opts.dealId,
    rep_email: opts.actorEmail,
    to_email: opts.to,
    subject: opts.subject,
    links: trackedLinks,
  });

  return { messageId, activityId: act?.id ?? null, trackToken };
}
