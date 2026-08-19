"use client";

import { useEffect, useState } from "react";

export interface Roster {
  active: { id: number; name: string; email: string | null }[];
  names: Record<string, string>;
  mentionable: { email: string; name: string }[];
}

const EMPTY: Roster = { active: [], names: {}, mentionable: [] };
let cache: { at: number; data: Roster } | null = null;
let inflight: Promise<Roster> | null = null;

async function fetchRoster(): Promise<Roster> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.data;
  inflight ??= fetch("/api/users/roster")
    .then((r) => (r.ok ? r.json() : EMPTY))
    .then((d) => {
      cache = { at: Date.now(), data: d };
      return d as Roster;
    })
    .catch(() => EMPTY)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Team roster (owner ids/names + mentionable users), cached 5 min per tab. */
export function useRoster(): Roster {
  const [roster, setRoster] = useState<Roster>(cache?.data ?? EMPTY);
  useEffect(() => {
    let alive = true;
    void fetchRoster().then((r) => alive && setRoster(r));
    return () => {
      alive = false;
    };
  }, []);
  return roster;
}

/** Owner-id → display name with a sensible fallback. */
export function ownerName(roster: Roster, id: number | string | null | undefined): string {
  if (id == null || id === "") return "—";
  return roster.names[String(id)] ?? `#${id}`;
}
