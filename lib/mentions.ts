import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * @mentions in notes. The composer inserts "@Full Name" from the roster
 * picker; the server re-extracts against the current user list (robust
 * across every note entry point) and stores the mentioned emails on the
 * activity row's meta.mentions — the notifications feed reads that.
 */

export interface TeamUser {
  email: string;
  name: string | null;
}

/** All provisioned users (app_users ∪ their rep names). */
export async function listTeamUsers(db: SupabaseClient): Promise<TeamUser[]> {
  const { data } = await db.from("app_users").select("email, reps ( name )");
  return (data ?? []).map((u: any) => ({
    email: u.email,
    name: (Array.isArray(u.reps) ? u.reps[0] : u.reps)?.name ?? null,
  }));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Emails of users whose "@Name" (or "@email") appears in the text. */
export async function extractMentions(db: SupabaseClient, text: string | null | undefined): Promise<string[]> {
  if (!text || !text.includes("@")) return [];
  const users = await listTeamUsers(db);
  const out = new Set<string>();
  for (const u of users) {
    if (u.name && new RegExp(`@${esc(u.name)}(?![\\w])`, "i").test(text)) out.add(u.email);
    else if (new RegExp(`@${esc(u.email)}(?![\\w.])`, "i").test(text)) out.add(u.email);
    // First-name fallback — only when unambiguous across the roster.
    else if (u.name) {
      const first = u.name.split(/\s+/)[0];
      const sameFirst = users.filter((x) => x.name && x.name.split(/\s+/)[0].toLowerCase() === first.toLowerCase());
      if (sameFirst.length === 1 && new RegExp(`@${esc(first)}(?![\\w])`, "i").test(text)) out.add(u.email);
    }
  }
  return [...out];
}

/** Merge mentions into an activity meta object (returns undefined if none and no prior meta). */
export function withMentions(meta: Record<string, unknown> | null | undefined, mentions: string[]): Record<string, unknown> | undefined {
  if (mentions.length === 0) return (meta ?? undefined) as Record<string, unknown> | undefined;
  return { ...(meta ?? {}), mentions };
}
