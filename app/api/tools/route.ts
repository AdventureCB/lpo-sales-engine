import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ToolDef {
  key: string;
  label: string;
  emoji: string;
  url: string;
}

/** Seed set — admin edits persist to crm_sync_state `tool_links`. */
const DEFAULTS: ToolDef[] = [
  { key: "gorgias", label: "Gorgias", emoji: "🎧", url: "https://lonepeakoverland.gorgias.com" },
  { key: "shopify", label: "Shopify", emoji: "🛍", url: "https://admin.shopify.com" },
  { key: "clickup", label: "ClickUp", emoji: "✅", url: "https://app.clickup.com" },
  { key: "calendly", label: "Calendly", emoji: "🗓", url: "https://calendly.com/app" },
  { key: "browser", label: "Web browser", emoji: "🌐", url: "https://lpo-sales-engine.vercel.app/browser" },
  { key: "ops", label: "Lone Peak Ops", emoji: "🏔", url: "" },
];

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const { data } = await db.from("crm_sync_state").select("value").eq("key", "tool_links").maybeSingle();
  const tools = ((data?.value as any)?.tools as ToolDef[]) ?? DEFAULTS;
  return NextResponse.json({ tools, isAdmin: user.role === "admin" });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { tools?: ToolDef[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const tools = (body.tools ?? [])
    .filter((t) => t && t.key && t.label)
    .map((t) => ({
      key: String(t.key).slice(0, 24).replace(/[^a-z0-9-]/gi, ""),
      label: String(t.label).slice(0, 40),
      emoji: String(t.emoji ?? "🔗").slice(0, 8),
      url: String(t.url ?? "").slice(0, 500),
    }));
  const db = supabaseAdmin();
  await db
    .from("crm_sync_state")
    .upsert({ key: "tool_links", value: { tools }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return NextResponse.json({ ok: true, tools });
}
