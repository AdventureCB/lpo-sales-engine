import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Outreach library: macros + assets. Read = everyone; manage = admin. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const [{ data: macros }, { data: assets }] = await Promise.all([
    db.from("comm_macros").select("*").order("sort_order").order("name"),
    db.from("comm_assets").select("*").order("kind").order("name"),
  ]);
  return NextResponse.json({ macros: macros ?? [], assets: assets ?? [] });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  let body: {
    op?: "macro" | "macro_delete" | "asset" | "asset_delete";
    macro?: { id?: string; channel?: string; name?: string; subject?: string | null; body?: string };
    asset?: { id?: string; kind?: string; name?: string; url?: string };
    id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();

  if (body.op === "macro") {
    const m = body.macro;
    if (!m?.name?.trim() || !m.body?.trim() || !["sms", "whatsapp", "email", "any"].includes(m.channel ?? "")) {
      return NextResponse.json({ error: "channel, name, body required" }, { status: 400 });
    }
    const row = {
      channel: m.channel,
      name: m.name.trim(),
      subject: m.subject?.trim() || null,
      body: m.body,
      updated_at: new Date().toISOString(),
    };
    const q = m.id
      ? db.from("comm_macros").update(row).eq("id", m.id)
      : db.from("comm_macros").insert(row);
    const { error } = await q;
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  if (body.op === "macro_delete" && body.id) {
    await db.from("comm_macros").delete().eq("id", body.id);
    return NextResponse.json({ ok: true });
  }
  if (body.op === "asset") {
    const a = body.asset;
    if (!a?.name?.trim() || !a.url?.trim() || !["url", "media"].includes(a.kind ?? "")) {
      return NextResponse.json({ error: "kind, name, url required" }, { status: 400 });
    }
    const row = { kind: a.kind, name: a.name.trim(), url: a.url.trim() };
    const q = a.id ? db.from("comm_assets").update(row).eq("id", a.id) : db.from("comm_assets").insert(row);
    const { error } = await q;
    if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  if (body.op === "asset_delete" && body.id) {
    await db.from("comm_assets").delete().eq("id", body.id);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}
