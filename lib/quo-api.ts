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

type QuoParams = Record<string, string | string[]>;

async function quoGet(path: string, params: QuoParams): Promise<any> {
  const url = new URL(`${BASE()}${path}`);
  for (const [k, v] of Object.entries(params)) {
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  }
  const res = await fetch(url, {
    // Quo's WAF rejects default/absent library user agents
    headers: { Authorization: env("QUO_API_KEY"), "User-Agent": "lpo-sales-engine/0.1" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Quo ${path} ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function paginate(path: string, baseParams: QuoParams): Promise<any[]> {
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

export interface QuoTranscriptDialogue {
  content: string | null;
  userId: string | null; // null → external contact
}

/** Transcript for a call, or null when absent/processing/unavailable. */
export async function getCallTranscript(callId: string): Promise<QuoTranscriptDialogue[] | null> {
  try {
    const res = await quoGet(`/call-transcripts/${callId}`, {});
    if (res?.data?.status !== "completed" || !Array.isArray(res.data.dialogue)) return null;
    return res.data.dialogue;
  } catch (e) {
    // 404 = no transcript for this call (e.g. plan limits, very short call)
    if (e instanceof Error && /404/.test(e.message)) return null;
    throw e;
  }
}

/** Run tasks with bounded concurrency, pacing under Quo's 10 req/s. */
export async function quoPool<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = 4
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    out.push(...(await Promise.all(chunk.map(fn))));
    if (i + concurrency < items.length) await new Promise((r) => setTimeout(r, 500));
  }
  return out;
}

export interface QuoMessage {
  id: string;
  direction: "incoming" | "outgoing";
  userId: string | null;
  status: string;
  createdAt: string;
}

/**
 * All calls on a number in the window: conversations → participants → calls
 * per participant (the API allows exactly one per query), CONCURRENCY at a
 * time (≤8 req/s vs Quo's 10 limit).
 */
export async function listCallsForNumber(opts: {
  phoneNumberId: string;
  createdAfter: string;
}): Promise<QuoCall[]> {
  const participants = await listConversationParticipants({
    phoneNumberId: opts.phoneNumberId,
    updatedAfter: opts.createdAfter,
  });
  const byId = new Map<string, QuoCall>();
  const results = await quoPool(participants, (participant) =>
    listCallsWithParticipant({ ...opts, participant }).catch((e) => {
      console.error(`quo calls fetch failed for participant`, e);
      return [] as QuoCall[];
    })
  );
  for (const calls of results) for (const c of calls) byId.set(c.id, c);
  return [...byId.values()];
}

/** All messages on a number in the window; /v1/messages takes up to 10 participants per query. */
export async function listMessagesForNumber(opts: {
  phoneNumberId: string;
  createdAfter: string;
}): Promise<QuoMessage[]> {
  const participants = await listConversationParticipants({
    phoneNumberId: opts.phoneNumberId,
    updatedAfter: opts.createdAfter,
  });
  const batches: string[][] = [];
  for (let i = 0; i < participants.length; i += 10) batches.push(participants.slice(i, i + 10));
  const byId = new Map<string, QuoMessage>();
  const results = await quoPool(batches, (batch) =>
    paginate("/messages", {
      phoneNumberId: opts.phoneNumberId,
      "participants[]": batch,
      createdAfter: opts.createdAfter,
    }).catch((e) => {
      console.error(`quo messages fetch failed for batch`, e);
      return [] as QuoMessage[];
    })
  );
  for (const msgs of results) for (const m of msgs) byId.set(m.id, m);
  return [...byId.values()];
}
