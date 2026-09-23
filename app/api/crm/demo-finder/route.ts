import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { zipCoords, zip5, milesBetween } from "@/lib/camper-owners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Find camper owners near a location (rep-typed zip). Sales + admin. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const zip = zip5(p.get("zip"));
  const radius = Math.min(Math.max(Number(p.get("radius") ?? 150) || 150, 10), 1000);
  const version = p.get("version"); // v1 | v2 | (all)
  const willingOnly = p.get("willing") === "1";
  const q = (p.get("q") ?? "").trim().toLowerCase();

  if (!zip) return NextResponse.json({ error: "a valid US zip is required" }, { status: 400 });
  const origin = zipCoords(zip);
  if (!origin) return NextResponse.json({ error: `unknown zip ${zip}` }, { status: 400 });

  // Bounding-box prefilter (uses the lat/lng index; keeps us under the row cap).
  const latPad = radius / 69;
  const lngPad = radius / (69 * Math.max(Math.cos((origin[0] * Math.PI) / 180), 0.01));
  let query = supabaseAdmin()
    .from("camper_owners")
    .select("id, name, email, phone, city, state, zip, lat, lng, version, camper_order_name, camper_order_at, order_line_items, contact_id, willing_to_demo, willing_at, shopify_customer_id")
    .not("lat", "is", null)
    .eq("eligible", true) // fulfilled, not cancelled/refunded camper order only (Kyle 9/23)
    .gte("lat", origin[0] - latPad)
    .lte("lat", origin[0] + latPad)
    .gte("lng", origin[1] - lngPad)
    .lte("lng", origin[1] + lngPad)
    .limit(1000);
  if (version === "v1" || version === "v2") query = query.in("version", version === "v1" ? ["v1", "both"] : ["v2", "both"]);
  if (willingOnly) query = query.eq("willing_to_demo", true);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  const owners = (data ?? [])
    .map((o: any) => ({ ...o, miles: Math.round(milesBetween(origin, [o.lat, o.lng])) }))
    .filter((o: any) => o.miles <= radius)
    .filter((o: any) => !q || `${o.name} ${o.city} ${o.email}`.toLowerCase().includes(q))
    .sort((a: any, b: any) => a.miles - b.miles)
    .slice(0, 200)
    .map((o: any) => ({
      id: o.id,
      name: o.name,
      email: o.email,
      phone: o.phone,
      city: o.city,
      state: o.state,
      zip: o.zip,
      miles: o.miles,
      version: o.version,
      willing: o.willing_to_demo,
      willingAt: o.willing_at,
      orderName: o.camper_order_name,
      orderAt: o.camper_order_at,
      items: o.order_line_items ?? [],
      contactId: o.contact_id,
      shopifyUrl: o.shopify_customer_id
        ? `https://admin.shopify.com/store/lone-peak-overland/customers/${String(o.shopify_customer_id).replace(/\D/g, "")}`
        : null,
    }));

  return NextResponse.json({ origin: { zip, lat: origin[0], lng: origin[1] }, radius, count: owners.length, owners });
}

/** Mark an owner willing / not-willing to demo. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { id?: string; op?: string; willing?: boolean; note?: string; city?: string; state?: string; zip?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const db = supabaseAdmin();

  // Manual address correction (customer moved) — re-geocode, and mark it
  // manual so the sync never overwrites it with the billing address again.
  if (body.op === "address") {
    const z = zip5(body.zip);
    if (!z) return NextResponse.json({ error: "a valid US zip is required" }, { status: 400 });
    const coords = zipCoords(z);
    if (!coords) return NextResponse.json({ error: `unknown zip ${z}` }, { status: 400 });
    const { error } = await db
      .from("camper_owners")
      .update({
        city: body.city?.trim() || null,
        state: (body.state ?? "").trim().toUpperCase().slice(0, 2) || null,
        zip: z,
        lat: coords[0],
        lng: coords[1],
        address_manual: true,
      })
      .eq("id", body.id);
    return NextResponse.json({ ok: !error, lat: coords[0], lng: coords[1], zip: z });
  }

  const patch: Record<string, unknown> = {
    willing_to_demo: !!body.willing,
    willing_at: body.willing ? new Date().toISOString() : null,
    willing_by: body.willing ? user.email : null,
  };
  if (typeof body.note === "string") patch.notes = body.note.slice(0, 500);
  const { error } = await db.from("camper_owners").update(patch).eq("id", body.id);
  return NextResponse.json({ ok: !error });
}
