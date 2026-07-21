import "server-only";
import { env, envOptional } from "./env";

/**
 * Quo REST client (docs: quo.com/docs). Auth is the raw API key in the
 * Authorization header (no Bearer prefix). Rate limit 10 req/s.
 *
 * GET /v1/calls enforces `participants` (exactly one external number per
 * query — verified live 2026-07-20), so there is no direct "all calls on
 * this number" listing. Reconciliation therefore goes two-step: list
 * conversations updated in the window (they carry participant numbers),
 * then fetch calls per participant with bounded concurrency.
 */

const BASE = () => envOptional("QUO_API_BASE") ?? "https://api.quo.com/v1";

export interface QuoCall {
  id: string;
  phoneNumberId: string;
  userId: string | null;
  direction: "incoming" | "outgoing";
  status: string;
  createdAt: string;
  answeredAt: string | null;
  completedAt: string | null;
  duration: number | null;
  participants: string[];
}

async function quoGet(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${BASE()}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: env("QUO_API_KEY") } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Quo ${path} ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function paginate(path: string, baseParams: Record<string, string>): Promise<any[]> {
  const items: any[] = [];
  let pageToken: string | null = null;
  do {
    const params: Record<string, string> = { ...baseParams, maxResults: "100" };
    if (pageToken) params.pageToken = pageToken;
    const page = await quoGet(path, params);
    items.push(...(page.data ?? []));
    pageToken = page.nextPageToken ?? null;
    if (pageToken) await new Promise((r) => setTimeout(r, 150));
  } while (pageToken);
  return items;
}

export async function listCallsWithParticipant(opts: {
  phoneNumberId: string;
  participant: string;
  userId?: string;
  createdAfter: string;
}): Promise<QuoCall[]> {
  const params: Record<string, string> = {
    phoneNumberId: opts.phoneNumberId,
    "participants[]": opts.participant,
    createdAfter: opts.createdAfter,
  };
  if (opts.userId) params.userId = opts.userId;
  return paginate("/calls", params);
}

export async function listConversationParticipants(opts: {
  phoneNumberId: string;
  updatedAfter: string;
}): Promise<string[]> {
  const conversations = await paginate("/conversations", {
    "phoneNumbers[]": opts.phoneNumberId,
    updatedAfter: opts.updatedAfter,
  });
  const participants = new Set<string>();
  for (const c of conversations) {
    for (const p of c.participants ?? []) if (p) participants.add(p);
  }
  return [...participants];
}

/**
 * All calls on a number in the window: conversations → participants → calls
 * per participant, CONCURRENCY at a time (≤8 req/s vs Quo's 10 limit).
 */
export async function listCallsForNumber(opts: {
  phoneNumberId: string;
  userId?: string;
  createdAfter: string;
}): Promise<QuoCall[]> {
  const CONCURRENCY = 4;
  const participants = await listConversationParticipants({
    phoneNumberId: opts.phoneNumberId,
    updatedAfter: opts.createdAfter,
  });
  const byId = new Map<string, QuoCall>();
  for (let i = 0; i < participants.length; i += CONCURRENCY) {
    const chunk = participants.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map((participant) =>
        listCallsWithParticipant({ ...opts, participant }).catch((e) => {
          console.error(`quo calls fetch failed for participant`, e);
          return [] as QuoCall[];
        })
      )
    );
    for (const calls of results) for (const c of calls) byId.set(c.id, c);
    if (i + CONCURRENCY < participants.length) await new Promise((r) => setTimeout(r, 500));
  }
  return [...byId.values()];
}
