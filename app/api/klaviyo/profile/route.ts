import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getProfileByEmail, getProfileEvents } from "@/lib/klaviyo";
import { normalizeEmail, normalizePhone } from "@/lib/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FoundPhone {
  source: string;
  raw: string;
  e164: string | null;
}

/**
 * Klaviyo profile lookup by email: phones from the standard field AND any
 * phone-ish custom property, plus recent events. Saves the manual
 * search-Klaviyo-for-the-number routine when the Zap drops phones.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const email = normalizeEmail(new URL(req.url).searchParams.get("email"));
  if (!email) return NextResponse.json({ error: "valid email required" }, { status: 400 });

  try {
    const profile = await getProfileByEmail(email);
    if (!profile) return NextResponse.json({ profile: null });

    const phones: FoundPhone[] = [];
    const seen = new Set<string>();
    const addPhone = (source: string, raw: unknown) => {
      if (typeof raw !== "string" && typeof raw !== "number") return;
      const str = String(raw).trim();
      if (!str) return;
      const e164 = normalizePhone(str);
      const key = e164 ?? str;
      if (seen.has(key)) return;
      seen.add(key);
      phones.push({ source, raw: str, e164 });
    };

    addPhone("Information · phone_number", profile.phoneNumber);
    for (const [k, v] of Object.entries(profile.properties)) {
      if (/phone|mobile|cell/i.test(k)) addPhone(`Custom property · ${k}`, v);
    }
    // catch phone-shaped values under non-phone-named keys
    for (const [k, v] of Object.entries(profile.properties)) {
      if (/phone|mobile|cell/i.test(k)) continue;
      if ((typeof v === "string" || typeof v === "number") && normalizePhone(String(v))) {
        addPhone(`Custom property · ${k}`, v);
      }
    }

    const events = await getProfileEvents(profile.id);

    return NextResponse.json({
      profile: {
        id: profile.id,
        email: profile.email,
        name: [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null,
        created: profile.created,
        location: profile.location,
        phones,
      },
      events,
    });
  } catch (e) {
    console.error("klaviyo profile lookup failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "lookup failed" }, { status: 500 });
  }
}
