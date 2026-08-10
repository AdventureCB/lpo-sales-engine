import type { SupabaseClient } from "@supabase/supabase-js";
import { mergeContactAttribution, linkVisitor } from "./attribution";

/**
 * Fold a stored Typeform submission (hidden-field ad params + email) into
 * its CRM contact. Returns true when matched — or when there's nothing to
 * land (organic submission), which needs no retry.
 */
export async function matchSubmission(
  db: SupabaseClient,
  sub: { id: string; email: string | null; hidden: Record<string, unknown>; submitted_at: string | null }
): Promise<boolean> {
  if (!sub.email) return false;
  const h = sub.hidden ?? {};
  const S = (k: string) =>
    typeof h[k] === "string" && (h[k] as string).trim() ? (h[k] as string).trim().slice(0, 200) : undefined;
  const touch: Record<string, string | undefined> = {
    source: S("utm_source"),
    medium: S("utm_medium"),
    campaign: S("utm_campaign"),
    content: S("utm_content"),
    term: S("utm_term"),
    gclid: S("gclid"),
    fbclid: S("fbclid"),
    at: sub.submitted_at ?? new Date().toISOString(),
  };
  const clean = Object.fromEntries(Object.entries(touch).filter(([, v]) => v)) as any;
  const hasAd = clean.source || clean.gclid || clean.fbclid;

  let merged = false;
  if (hasAd) {
    merged = await mergeContactAttribution(db, sub.email, { first: clean, last: clean, touches: [clean] });
  }
  const vid = S("vid");
  if (vid) await linkVisitor(db, { attr_vid: vid }, sub.email);

  if (merged || !hasAd) {
    await db.from("typeform_submissions").update({ matched_at: new Date().toISOString() }).eq("id", sub.id);
    return true;
  }
  return false;
}
