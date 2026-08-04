import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { envOptional, env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin settings: rep ↔ Telnyx number assignment (config tab). */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const db = supabaseAdmin();
  const { data: reps } = await db
    .from("reps")
    .select("id, name, quo_phone_number, telnyx_number")
    .eq("active", true)
    .order("sort_order");

  let numbers: string[] = [];
  if (envOptional("TELNYX_API_KEY")) {
    try {
      const res = await fetch("https://api.telnyx.com/v2/phone_numbers?page[size]=50", {
        headers: { Authorization: `Bearer ${env("TELNYX_API_KEY")}` },
      });
      const json = await res.json();
      numbers = (json.data ?? []).map((n: any) => n.phone_number);
    } catch (e) {
      console.error("telnyx numbers list", e);
    }
  }
  return NextResponse.json({ reps: reps ?? [], telnyxNumbers: numbers });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { repId?: string; telnyxNumber?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.repId) return NextResponse.json({ error: "repId required" }, { status: 400 });
  const { error } = await supabaseAdmin()
    .from("reps")
    .update({ telnyx_number: body.telnyxNumber || null })
    .eq("id", body.repId);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
