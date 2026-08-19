import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Team roster for any logged-in user: powers owner dropdowns/filters and the
 * @mention picker. `active` = current pickable owners (active reps with a
 * Pipedrive/synthetic owner id); `names` maps EVERY known owner id → name so
 * historical owners still label correctly after deactivation.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const [{ data: reps }, { data: users }] = await Promise.all([
    db.from("reps").select("name, email, pipedrive_user_id, active"),
    db.from("app_users").select("email, role, reps ( name, active )"),
  ]);
  const names: Record<string, string> = {};
  for (const r of reps ?? []) if (r.pipedrive_user_id != null) names[String(r.pipedrive_user_id)] = r.name;
  return NextResponse.json({
    active: (reps ?? [])
      .filter((r) => r.active && r.pipedrive_user_id != null)
      .map((r) => ({ id: r.pipedrive_user_id, name: r.name, email: r.email }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    names,
    // Mentionable users = everyone with a login (admins included).
    mentionable: (users ?? [])
      .map((u: any) => {
        const rep = Array.isArray(u.reps) ? u.reps[0] : u.reps;
        return { email: u.email, name: rep?.name ?? u.email.split("@")[0], active: rep?.active !== false };
      })
      .filter((u: any) => u.active)
      .sort((a: any, b: any) => a.name.localeCompare(b.name)),
  });
}
