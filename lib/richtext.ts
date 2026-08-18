/**
 * Message body links. Composers insert asset URLs as markdown `[label](url)`
 * so the label is the visible text and the URL is the target. At send time
 * we render that to HTML for email (a real underlined hyperlink) and flatten
 * it to "label: url" for plain-text channels (SMS/WhatsApp).
 */

const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /(https?:\/\/[^\s<]+)/g;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render markdown links + bare URLs to HTML anchors; newlines to <br>. */
export function linkifyHtml(text: string): string {
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MD_LINK.lastIndex = 0;
  while ((m = MD_LINK.exec(text))) {
    parts.push(escapeHtml(text.slice(last, m.index)).replace(BARE_URL, '<a href="$1">$1</a>'));
    parts.push(`<a href="${escapeHtml(m[2])}">${escapeHtml(m[1])}</a>`);
    last = MD_LINK.lastIndex;
  }
  parts.push(escapeHtml(text.slice(last)).replace(BARE_URL, '<a href="$1">$1</a>'));
  return parts.join("").replace(/\r?\n/g, "<br>");
}

/** Flatten markdown links to "label: url" for plain-text channels. */
export function linkifyPlain(text: string): string {
  return text.replace(MD_LINK, "$1: $2");
}

/** True if the body contains any markdown link (→ send HTML for email). */
export function hasRichLinks(text: string): boolean {
  MD_LINK.lastIndex = 0;
  return MD_LINK.test(text);
}

/**
 * Rich (HTML) bodies. The email composer, email macros, and signatures store
 * HTML from the rich-text editor; plain-text-era values (markdown links +
 * newlines) still flow through linkifyHtml. isHtml() is how every consumer
 * tells the two apart.
 */

const HTML_TAG = /<\/?(p|div|br|b|strong|i|em|u|s|a|img|ul|ol|li|span|h[1-6]|blockquote|font)\b/i;

/** True if the value is editor-produced HTML rather than legacy plain text. */
export function isHtml(s: string): boolean {
  return HTML_TAG.test(s);
}

/**
 * Allowlist-lite sanitizer for outbound email HTML. The author is the rep
 * themselves, so this guards against pasted junk (scripts, event handlers,
 * javascript: URLs), not a hostile author.
 */
export function sanitizeEmailHtml(html: string): string {
  let s = html.replace(/<(script|style|iframe|object|embed|form|link|meta)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<\/?(script|iframe|object|embed|form|link|meta)[^>]*>/gi, "");
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/\s(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi, "");
  return s;
}

/** Flatten editor HTML to readable plain text (multipart alternative, timeline snippets, SMS fallback). */
export function htmlToPlain(html: string): string {
  let s = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
    const label = inner.replace(/<[^>]+>/g, "").trim();
    return label && label !== href ? `${label}: ${href}` : href;
  });
  s = s.replace(/<img[^>]*\salt="([^"]+)"[^>]*>/gi, "[$1]").replace(/<img[^>]*>/gi, "[image]");
  s = s.replace(/<li[^>]*>/gi, "\n• ");
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/blockquote|\/tr)[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Render any stored body (HTML or legacy plain) to sendable email HTML. */
export function toEmailHtml(s: string): string {
  return isHtml(s) ? sanitizeEmailHtml(s) : linkifyHtml(s);
}

/** Render any stored body (HTML or legacy plain) to plain text. */
export function toPlainText(s: string): string {
  return isHtml(s) ? htmlToPlain(s) : linkifyPlain(s);
}
