import "server-only";
import { env, envOptional } from "./env";

/**
 * Quo REST client (docs: quo.com/docs). Auth is the raw API key in the
 * Authorization header (no Bearer prefix). Rate limit 10 req/s — calls here
 * are sequential with a small delay, well under it.
 *
 * Note: the docs mark `participants` as required on GET /v1/calls, but
 * per-number listing without it was verified working during discovery — the
 * nightly reconciliation depends on that. If Quo starts enforcing the
 * documented shape this throws a clear error per rep instead of failing the
 * whole run.
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

export async function listCalls(opts: {
  phoneNumberId: string;
  userId?: string;
  createdAfter: string;
}): Promise<QuoCall[]> {
  const calls: QuoCall[] = [];
  let pageToken: string | null = null;
  do {
    const params: Record<string, string> = {
      phoneNumberId: opts.phoneNumberId,
      createdAfter: opts.createdAfter,
      maxResults: "100",
    };
    if (opts.userId) params.userId = opts.userId;
    if (pageToken) params.pageToken = pageToken;
    const page = await quoGet("/calls", params);
    calls.push(...(page.data ?? []));
    pageToken = page.nextPageToken ?? null;
    if (pageToken) await new Promise((r) => setTimeout(r, 150));
  } while (pageToken);
  return calls;
}
