import type { SupabaseClient } from "@supabase/supabase-js";
import { getProfileByEmail, type KlaviyoProfile } from "./klaviyo";
import { normalizePhone } from "./identity";
import { enqueuePdSync } from "./pd-sync";

/**
 * Klaviyo phone adoption — a contact with NO usable phone (none, or every
 * one flagged bad) gets the first phone Klaviyo has for their email, with no
 * rep action (Kyle 9/23). Two entry points share the same adopt step:
 *   - the deal page's Klaviyo panel (contact-events) — instant on open
 *   - sweepKlaviyoPhones() on the 15-min Klaviyo cron — BACKGROUND, so a
 *     saved build that arrived phone-less becomes sprint-list eligible
 *     without anyone opening it
 * Contacts that already have a working number are never touched (the panel
 * keeps its manual "+ Add" suggestion for extra numbers).
 */

interface Phone { value: string; e164?: string; primary?: boolean; label?: string; bad?: boolean; bad_at?: string }

/** Every phone on a Klaviyo profile: the standard field plus phone-ish custom properties. */
export function profilePhones(profile: KlaviyoProfile | null | undefined): string[] {
  if (!profile) return [];
  const found: string[] = [];
  const push = (v: unknown) => {
    if ((typeof v === "string" || typeof v === "number") && String(v).replace(/\D/g, "").length >= 10 && !found.includes(String(v))) found.push(String(v));
  };
  push(profile.phoneNumber);
  for (const [k, v] of Object.entries(profile.properties ?? {})) if (/phone|mobile|cell/i.test(k)) push(v);
  return found;
}

export function profileTruck(profile: KlaviyoProfile | null | undefined): string | null {
  for (const [k, v] of Object.entries(profile?.properties ?? {})) {
    if (/truck|vehicle/i.test(k) && typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Add Klaviyo's phone to a contact that has no usable one. Idempotent; returns the adopted E.164 or null. */
export async function autoAdoptPhone(db: SupabaseClient, contactId: string, dealId: string | null, klaviyoPhones: string[]): Promise<string | null> {
  const { data: contact } = await db.from("crm_contacts").select("id, phones, pipedrive_person_id").eq("id", contactId).maybeSingle();
  if (!contact) return null;
  const phones = [...(((contact.phones as Phone[] | null) ?? []))];
  if (phones.some((p) => !p.bad)) return null;
  const have = new Set(phones.map((p) => p.e164 ?? normalizePhone(p.value) ?? p.value));
  const pick = klaviyoPhones.map((p) => normalizePhone(p)).find((p): p is string => !!p && !have.has(p));
  if (!pick) return null;
  phones.push({ value: pick, e164: pick, primary: phones.length === 0, label: "klaviyo" });
  const { error } = await db.from("crm_contacts").update({ phones, updated_at: new Date().toISOString() }).eq("id", contactId);
  if (error) return null;
  if (contact.pipedrive_person_id) {
    await enqueuePdSync(db, "person_update", { personId: contact.pipedrive_person_id, phones: phones.map((p) => ({ value: p.e164 ?? p.value, primary: !!p.primary })) });
  }
  await db.from("crm_activities").insert({
    deal_id: dealId,
    contact_id: contactId,
    type: "system",
    subject: "📞 Phone added from Klaviyo",
    body: `${pick} was on the Klaviyo profile and the contact had no working number, so it was added automatically.`,
    actor: "system",
    occurred_at: new Date().toISOString(),
  });
  return pick;
}

/**
 * Background sweep: open deals whose contact has no usable phone → cached
 * Klaviyo phones when fresh, else one profile lookup (cached back, so each
 * contact costs at most one Klaviyo call per day). `limit` bounds lookups.
 */
export async function sweepKlaviyoPhones(db: SupabaseClient, opts: { limit?: number } = {}) {
  const limit = opts.limit ?? 40;
  const { data: rows, error } = await db.rpc("contacts_needing_phone", { p_limit: limit });
  if (error) return { error: error.message };
  const out = { candidates: (rows ?? []).length, lookups: 0, adopted: 0, no_phone_on_profile: 0, no_profile: 0, lookup_errors: 0 };
  for (const r of (rows ?? []) as { contact_id: string; email: string; deal_id: string; cached_phones: unknown; cache_fresh: boolean }[]) {
    let phones: string[] = Array.isArray(r.cached_phones) ? (r.cached_phones as unknown[]).filter((p): p is string => typeof p === "string") : [];
    if (!(r.cache_fresh && phones.length)) {
      out.lookups++;
      let profile: KlaviyoProfile | null;
      try {
        profile = await getProfileByEmail(r.email);
      } catch {
        out.lookup_errors++; // Klaviyo down ≠ "no profile" — don't cache a negative
        continue;
      }
      phones = profilePhones(profile);
      await db.from("klaviyo_profiles").upsert(
        { email: r.email, profile_id: profile?.id ?? "none", phones, ...(profile ? { truck_model: profileTruck(profile) } : {}), updated_at: new Date().toISOString() },
        { onConflict: "email" }
      );
      if (!profile) { out.no_profile++; continue; }
    }
    if (!phones.length) { out.no_phone_on_profile++; continue; }
    if (await autoAdoptPhone(db, r.contact_id, r.deal_id, phones)) out.adopted++;
  }
  return out;
}
