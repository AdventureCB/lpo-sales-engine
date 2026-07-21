import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { DEFAULT_RULES, type HotRules } from "@/lib/hotlist";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

const NUMERIC_KEYS = Object.keys(DEFAULT_RULES) as Array<keyof HotRules>;

/** Update hot-list flag rules (thresholds are config, not code). Admin only. */
export async function PUT(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: Partial<HotRules>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const rules: Record<string, number> = {};
  for (const key of NUMERIC_KEYS) {
    const v = Number(body[key]);
    if (!Number.isFinite(v) || v < 1 || v > 365) {
      return NextResponse.json({ error: `invalid ${key}` }, { status: 400 });
    }
    rules[key] = Math.round(v);
  }

  const db = supabaseAdmin();
  const { error } = await db.from("app_config").update({ hot_rules: rules }).eq("id", true);
  if (error) {
    console.error("rules update failed", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }
  await db.from("admin_corrections").insert({
    actor: user.email,
    action: "update_hot_rules",
    target: "app_config.hot_rules",
    reason: `set to ${JSON.stringify(rules)}`,
  });
  return NextResponse.json({ ok: true, rules });
}
