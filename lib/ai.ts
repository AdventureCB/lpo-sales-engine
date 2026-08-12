import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";
import { MODEL_IDS, type ModelTier, estimateCostCents } from "./ai-profiler";

/**
 * Thin Anthropic Messages client. Structured output is forced via a single
 * tool (tool_choice), so the model must return schema-valid JSON. The big
 * reusable context (the taxonomy) is passed as a cached system block so we
 * only pay full price for it once per ~5-min window. Every call records
 * tokens + cost to ai_usage — the budget is a measured number, not a guess.
 */

const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

export interface ClaudeToolCall {
  input: any; // validated tool input (the structured output)
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costCents: number;
  model: string;
}

export async function callClaudeTool(opts: {
  tier: ModelTier;
  systemCached: string; // the reusable, cached context (taxonomy + instructions)
  systemLive?: string; // small non-cached preamble, optional
  user: string; // the per-request payload (this deal)
  tool: { name: string; description: string; input_schema: any };
  maxTokens?: number;
}): Promise<ClaudeToolCall> {
  const model = MODEL_IDS[opts.tier];
  const system: any[] = [];
  if (opts.systemLive) system.push({ type: "text", text: opts.systemLive });
  system.push({ type: "text", text: opts.systemCached, cache_control: { type: "ephemeral" } });

  const res = await fetch(API, {
    method: "POST",
    headers: {
      "x-api-key": env("ANTHROPIC_API_KEY"),
      "anthropic-version": VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 2200,
      system,
      messages: [{ role: "user", content: opts.user }],
      tools: [opts.tool],
      tool_choice: { type: "tool", name: opts.tool.name },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const toolUse = (data.content ?? []).find((c: any) => c.type === "tool_use");
  if (!toolUse) throw new Error("no tool_use in response");

  const u = data.usage ?? {};
  const usage = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
  // Cost: full-price non-cached input (incl. cache writes) + discounted reads + output.
  const totalIn = usage.input + usage.cacheRead + usage.cacheWrite;
  const costCents = estimateCostCents(opts.tier, totalIn, usage.output, usage.cacheRead);
  return { input: toolUse.input, usage, costCents, model };
}

/** Record one model call to the ai_usage ledger. Never throws. */
export async function logAiUsage(
  db: SupabaseClient,
  row: { dealId?: string | null; task: string; tier: ModelTier; call: ClaudeToolCall }
): Promise<void> {
  try {
    await db.from("ai_usage").insert({
      deal_id: row.dealId ?? null,
      task: row.task,
      model: row.call.model,
      tokens_in: row.call.usage.input + row.call.usage.cacheWrite,
      tokens_out: row.call.usage.output,
      cache_read_tokens: row.call.usage.cacheRead,
      cost_cents: row.call.costCents,
    });
  } catch (e) {
    console.error("ai_usage log failed", e);
  }
}
