import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "./supabase";
import { env } from "./env";

export interface SessionUser {
  authUserId: string;
  email: string;
  role: "admin" | "sales";
  repId: string | null;
  repName: string | null;
  pipedriveUserId: number | null;
  quoUserId: string | null;
}

/**
 * Resolve the logged-in user + role for a server component / route handler.
 * Returns null when unauthenticated or not provisioned in app_users.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => {}, // read-only in RSC/route context; middleware refreshes
    },
  });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const db = supabaseAdmin();
  const { data } = await db
    .from("app_users")
    .select("id, email, role, rep_id, reps ( name, pipedrive_user_id, quo_user_id )")
    .eq("id", user.id)
    .maybeSingle();
  if (!data) return null;

  const repRaw = Array.isArray(data.reps) ? data.reps[0] : data.reps;
  const rep = (repRaw ?? null) as { name: string; pipedrive_user_id: number | null; quo_user_id: string | null } | null;
  return {
    authUserId: data.id,
    email: data.email,
    role: data.role,
    repId: data.rep_id,
    repName: rep?.name ?? null,
    pipedriveUserId: rep?.pipedrive_user_id ?? null,
    quoUserId: rep?.quo_user_id ?? null,
  };
}
