import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Manual theme catalog CRUD (the critic proposes; this is direct editing). */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const { data } = await supabaseAdmin().from("comm_themes").select("*").order("sort_order").order("name");
  return NextResponse.json({ themes: data ?? [] });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: {
    op?: "upsert" | "toggle" | "delete";
    key?: string;
    name?: string;
    intent?: string;
    promptDirection?: string;
    channels?: string[];
    sortOrder?: number;
    enabled?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const key = String(body.key ?? "").trim();
  if (!/^[a-z0-9_]{2,40}$/.test(key)) return NextResponse.json({ error: "key must be snake_case (2-40 chars)" }, { status: 400 });
  const db = supabaseAdmin();

  if (body.op === "upsert") {
    if (!body.name?.trim() || !body.promptDirection?.trim())
      return NextResponse.json({ error: "name and prompt direction required" }, { status: 400 });
    const channels = (body.channels ?? ["email", "sms"]).filter((c) => c === "email" || c === "sms");
    const { error } = await db.from("comm_themes").upsert(
      {
        key,
        name: body.name.trim().slice(0, 60),
        intent: (body.intent ?? "").trim().slice(0, 200) || null,
        prompt_direction: body.promptDirection.trim().slice(0, 1000),
        channels: channels.length ? channels : ["email", "sms"],
        sort_order: Number.isFinite(body.sortOrder) ? Number(body.sortOrder) : 100,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
      { onConflict: "key" }
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  } else if (body.op === "toggle") {
    const { error } = await db.from("comm_themes").update({ enabled: body.enabled === true }).eq("key", key);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  } else if (body.op === "delete") {
    const { error } = await db.from("comm_themes").delete().eq("key", key);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  } else {
    return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
