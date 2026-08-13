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
