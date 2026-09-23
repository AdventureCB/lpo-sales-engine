import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { getProfileByEmail, getProfileEvents } from "@/lib/klaviyo";
import { normalizePhone } from "@/lib/identity";
import { enqueuePdSync } from "@/lib/pd-sync";

interface Phone { value: string; e164?: string; primary?: boolean; label?: string; bad?: boolean; bad_at?: string }

/**
 * A contact with NO usable phone (none, or every one flagged bad) gets the
 * first Klaviyo phone added automatically — no "+ Add" click (Kyle 9/23).
 * Contacts that already have a working number keep the manual suggestion.
 * Idempotent: a second call sees the phone and does nothing.
 */
async function autoAdoptPhone(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
  dealId: string | null,
  klaviyoPhones: string[]
): Promise<string | null> {
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYNC_COOLDOWN_MS = 60_000; // at most one Klaviyo sweep per contact/min
const PROFILE_REFRESH_MS = 24 * 3600_000; // re-check phones daily
const FIRST_PULL = 60;

/**
 * Marketing-signal feed, persistence-backed: events are stored on first
 * view and later calls pull only what's newer than the latest stored
 * event. Klaviyo is never hit more than once a minute per contact.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const email = url.searchParams.get("email")?.trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  const contactId = url.searchParams.get("contactId") || null;
  const dealId = url.searchParams.get("dealId") || null;

  const db = supabaseAdmin();
  const { data: cached } = await db.from("klaviyo_profiles").select("*").eq("email", email).maybeSingle();
  let profileId: string | null = cached?.profile_id ?? null;
  let phones: string[] = (cached?.phones as string[]) ?? [];
  let truckModel: string | null = (cached?.truck_model as string) ?? null;
  const lastSynced = cached?.last_synced_at ? Date.parse(cached.last_synced_at) : 0;
  const profileAge = cached?.updated_at ? Date.now() - Date.parse(cached.updated_at) : Infinity;

  let syncError: string | null = null;
  const needsProfile = !profileId || profileAge > PROFILE_REFRESH_MS;
  const needsSync = Date.now() - lastSynced > SYNC_COOLDOWN_MS;

  try {
    if (needsProfile) {
      const profile = await getProfileByEmail(email);
      if (!profile) {
        // Negative result cached too — avoids hammering for no-profile contacts.
        await db.from("klaviyo_profiles").upsert(
          { email, profile_id: profileId ?? "none", phones, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() },
          { onConflict: "email" }
        );
        return NextResponse.json({ events: [], profile: null });
      }
      profileId = profile.id;
      const found = new Set<string>();
      if (profile.phoneNumber) found.add(profile.phoneNumber);
      for (const [k, v] of Object.entries(profile.properties ?? {})) {
        if (/phone|mobile|cell/i.test(k) && typeof v === "string" && v.replace(/\D/g, "").length >= 10) {
          found.add(v);
        }
      }
      phones = [...found];
      for (const [k, v] of Object.entries(profile.properties ?? {})) {
        if (/truck|vehicle/i.test(k) && typeof v === "string" && v.trim()) {
          truckModel = v.trim();
          break;
        }
      }
      // Ad attribution stamped by attr.js lands as attr_* profile properties;
      // attr_vid links the visitor's beaconed touch history to this contact.
      try {
        const { touchesFromFlat, mergeContactAttribution, linkVisitor } = await import("@/lib/attribution");
        await mergeContactAttribution(db, email, touchesFromFlat(profile.properties ?? {}));
        await linkVisitor(db, profile.properties ?? {}, email);
      } catch {}
    }

    if (profileId && profileId !== "none" && (needsSync || needsProfile)) {
      // Incremental: only events newer than the latest we already hold.
      const { data: newest } = await db
        .from("klaviyo_events")
        .select("event_at")
        .eq("email", email)
        .order("event_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const fresh = await getProfileEvents(
        profileId,
        newest ? 200 : FIRST_PULL,
        newest?.event_at ?? undefined
      );
      if (fresh.length > 0) {
        await db.from("klaviyo_events").upsert(
          fresh.map((e) => ({
            id: e.id,
            profile_id: profileId,
            email,
            metric: e.metric,
            event_at: e.datetime,
            detail: e.detail,
          })),
          { onConflict: "id", ignoreDuplicates: true }
        );
      }
      await db.from("klaviyo_profiles").upsert(
        {
          email,
          profile_id: profileId,
          phones,
          truck_model: truckModel,
          last_synced_at: new Date().toISOString(),
          ...(needsProfile ? { updated_at: new Date().toISOString() } : {}),
        },
        { onConflict: "email" }
      );
    }
  } catch (e) {
    // Klaviyo down ≠ empty feed: serve what we have, flag the sync failure.
    syncError = e instanceof Error ? e.message : "klaviyo sync failed";
  }

  if (profileId === "none") return NextResponse.json({ events: [], profile: null });

  let autoAdded: string | null = null;
  if (contactId && phones.length) {
    try {
      autoAdded = await autoAdoptPhone(db, contactId, dealId, phones);
    } catch (e) {
      console.error("klaviyo phone auto-adopt failed", e);
    }
  }

  const { data: stored } = await db
    .from("klaviyo_events")
    .select("metric, event_at, detail")
    .eq("email", email)
    .order("event_at", { ascending: false })
    .limit(200);

  return NextResponse.json({
    profile: profileId ? { id: profileId, phones, truckModel } : null,
    events: (stored ?? []).map((e) => ({ metric: e.metric, at: e.event_at, detail: e.detail })),
    ...(autoAdded ? { autoAdded } : {}),
    ...(syncError ? { syncError } : {}),
  });
}
