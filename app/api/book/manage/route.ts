import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { cancelBooking, getBookingByToken } from "@/lib/booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const shape = (b: NonNullable<Awaited<ReturnType<typeof getBookingByToken>>>) => ({
  kind: b.kind,
  status: b.status,
  startAt: b.start_at,
  name: b.customer_name,
  email: b.customer_email,
  phone: b.customer_phone,
  tz: b.customer_tz,
  note: b.note,
  rep: b.rep ? { first: b.rep.first, slug: b.rep.slug } : null,
});

/** PUBLIC (token-scoped). GET ?token= → the booking; POST {token, action:"cancel"}. */
export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const b = await getBookingByToken(supabaseAdmin(), token);
  if (!b) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(shape(b));
}

export async function POST(req: NextRequest) {
  let body: { token?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (body.action !== "cancel" || !body.token) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const b = await cancelBooking(supabaseAdmin(), body.token, { reason: "cancelled" });
  if (!b) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(shape(b));
}
