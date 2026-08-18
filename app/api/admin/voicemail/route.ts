import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULTS = {
  enabled: true,
  delay_s: 25,
  greeting:
    "Hi, you've reached Lone Peak Overland. We can't take your call right now — please leave your name, number, and a quick message after the tone, and we'll get right back to you.",
};

/** Telnyx voicemail settings (greeting / ring window / on-off). Admin. */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const { data } = await supabaseAdmin().from("crm_sync_state").select("value").eq("key", "telnyx_vm").maybeSingle();
  return NextResponse.json({ config: { ...DEFAULTS, ...((data?.value as object) ?? {}) } });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { enabled?: boolean; delay_s?: number; greeting?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();
  const { data } = await db.from("crm_sync_state").select("value").eq("key", "telnyx_vm").maybeSingle();
  const next = {
    ...DEFAULTS,
    ...((data?.value as object) ?? {}),
    ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    ...(body.delay_s !== undefined ? { delay_s: Math.min(Math.max(Number(body.delay_s) || 25, 5), 45) } : {}),
    ...(body.greeting !== undefined ? { greeting: String(body.greeting).slice(0, 500) } : {}),
  };
  await db
    .from("crm_sync_state")
    .upsert({ key: "telnyx_vm", value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return NextResponse.json({ ok: true, config: next });
}
