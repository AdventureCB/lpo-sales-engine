import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getProfileByEmail, getProfileEvents } from "@/lib/klaviyo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Full Klaviyo event history for a contact (by email) — the deal page's
 * granular marketing-signal feed. Cart adds and saved builds are the
 * buying-mode leading indicators; the client highlights them.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const email = new URL(req.url).searchParams.get("email")?.trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  try {
    const profile = await getProfileByEmail(email);
    if (!profile) return NextResponse.json({ events: [], profile: null });
    const events = await getProfileEvents(profile.id, 60);
    // Phone enrichment: the standard field plus phone-shaped custom
    // properties (Klaviyo profiles often hide numbers there).
    const phones = new Set<string>();
    if (profile.phoneNumber) phones.add(profile.phoneNumber);
    for (const [k, v] of Object.entries(profile.properties ?? {})) {
      if (/phone|mobile|cell/i.test(k) && typeof v === "string" && v.replace(/\D/g, "").length >= 10) {
        phones.add(v);
      }
    }
    return NextResponse.json({
      profile: { id: profile.id, created: profile.created, phones: [...phones] },
      events: events.map((e) => ({
        metric: e.metric,
        at: e.datetime,
        detail: e.detail,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "klaviyo failed" },
      { status: 502 }
    );
  }
}
