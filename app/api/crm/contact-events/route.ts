import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { getProfileByEmail, getProfileEvents } from "@/lib/klaviyo";

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
  const email = new URL(req.url).searchParams.get("email")?.trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

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
      // Ad attribution stamped by attr.js lands as attr_* profile properties.
      try {
        const { touchesFromFlat, mergeContactAttribution } = await import("@/lib/attribution");
        await mergeContactAttribution(db, email, touchesFromFlat(profile.properties ?? {}));
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

  const { data: stored } = await db
    .from("klaviyo_events")
    .select("metric, event_at, detail")
    .eq("email", email)
    .order("event_at", { ascending: false })
    .limit(200);

  return NextResponse.json({
    profile: profileId ? { id: profileId, phones, truckModel } : null,
    events: (stored ?? []).map((e) => ({ metric: e.metric, at: e.event_at, detail: e.detail })),
    ...(syncError ? { syncError } : {}),
  });
}
