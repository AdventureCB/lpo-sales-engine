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
  // Includes inactive rows — admins have inactive rep identities so they can
  // hold numbers for testing without appearing on the scoreboard.
  const { data: reps } = await db
    .from("reps")
    .select("id, name, quo_phone_number, telnyx_number, active, daily_dial_goal, daily_talk_goal_min, bonus_dial_goal")
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
  let body: {
    repId?: string;
    telnyxNumber?: string | null;
    dialGoal?: number;
    talkGoalMin?: number;
    bonusDialGoal?: number; // 0 = clear → derived (1.5× min)
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.repId) return NextResponse.json({ error: "repId required" }, { status: 400 });
  const db = supabaseAdmin();
  const update: Record<string, unknown> = {};
  if ("telnyxNumber" in body) update.telnyx_number = body.telnyxNumber || null;
  if (typeof body.dialGoal === "number" && body.dialGoal > 0) {
    update.daily_dial_goal = Math.min(500, Math.round(body.dialGoal));
  }
  if (typeof body.talkGoalMin === "number" && body.talkGoalMin > 0) {
    update.daily_talk_goal_min = Math.min(480, Math.round(body.talkGoalMin));
  }
  if (typeof body.bonusDialGoal === "number") {
    update.bonus_dial_goal =
      body.bonusDialGoal > 0 ? Math.min(1000, Math.round(body.bonusDialGoal)) : null;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  const { error } = await db.from("reps").update(update).eq("id", body.repId);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  // Assigning a number provisions the rep's calling identity (their own
  // connection + credential, number routed to it) so inbound rings them.
  let warn: string | null = null;
  if (body.telnyxNumber) {
    try {
      const { data: rep } = await db
        .from("reps")
        .select("id, telnyx_connection_id, telnyx_credential_id")
        .eq("id", body.repId)
        .maybeSingle();
      if (rep) {
        const { provisionRepCalling } = await import("@/lib/telnyx");
        await provisionRepCalling(db, rep, body.telnyxNumber);
      }
    } catch (e) {
      warn = e instanceof Error ? e.message : String(e);
      console.error("rep provisioning failed", e);
    }
  }
  return NextResponse.json({ ok: true, warn });
}
