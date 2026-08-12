import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaudeTool, logAiUsage } from "./ai";
import {
  loadAiConfig,
  monthToDateSpendCents,
  type AiProfilerConfig,
  type ModelTier,
} from "./ai-profiler";

/**
 * The AI deal-profiler engine. One combined call per deal produces the whole
 * profile (attributes + archetype fit + summary + gap-driven next action +
 * data-sufficiency meter). Incremental by watermark: a re-run reconciles the
 * PRIOR read against only the new transcripts, never re-deriving from scratch.
 */

// ── Taxonomy → the cached system context ───────────────────────────────────
async function buildTaxonomy(db: SupabaseClient): Promise<{ text: string; attrKeys: string[]; archKeys: string[] }> {
  const [{ data: archs }, { data: attrs }] = await Promise.all([
    db.from("deal_archetypes").select("*").eq("enabled", true).order("sort_order"),
    db.from("profile_attributes").select("*").eq("enabled", true).order("sort_order"),
  ]);

  const archLines = (archs ?? []).map((a: any) => {
    const parts = [
      `### ${a.key} — ${a.name}`,
      a.description && a.description,
      a.positive_traits?.length && `Positive: ${a.positive_traits.join("; ")}`,
      a.negative_traits?.length && `Anti-signals (argue AGAINST): ${a.negative_traits.join("; ")}`,
      a.signals?.length && `Watch for: ${a.signals.join("; ")}`,
      a.ad_ids?.length && `Strong ad-ID match: ${a.ad_ids.join(", ")}`,
      a.selling_approach && `Approach: ${a.selling_approach}`,
    ].filter(Boolean);
    return parts.join("\n");
  });

  const attrLines = (attrs ?? []).map((a: any) => {
    const opts = a.options?.length ? ` [${a.value_type}: ${a.options.join(" | ")}]` : ` [${a.value_type}]`;
    return `- ${a.key} (${a.name}, importance ${a.importance}): ${a.description ?? ""}${opts}`;
  });

  const text = [
    `You are the deal-intelligence engine for Lone Peak Overland, which sells the Lone Peak Camper — a made-to-order pop-up wedge truck-bed camper (from $7k, ~400 lb, 15-second setup) plus power/solar, heating, and gear accessories. You read everything known about a deal (call transcripts, ad interactions, engagement signals, structured fields) and produce a structured buyer profile.`,
    ``,
    `## Archetypes (blended personas — a deal is a PERCENTAGE mix, not one label)`,
    `Score each relevant archetype 0-100 by fit. Use anti-signals to hold fits DOWN. Only include archetypes with a real basis; omit the rest. Percentages need not sum to 100.`,
    ``,
    archLines.join("\n\n"),
    ``,
    `## Universal attributes (fill what the evidence supports; importance 0-3 = how much it matters)`,
    attrLines.join("\n"),
    ``,
    `## Rules`,
    `- EVERY attribute value and archetype fit MUST cite evidence: a short quote or the specific signal it came from. No evidence → don't assert it.`,
    `- confidence is 0.0-1.0. Be honest — thin or conflicting input means LOW confidence, not a confident guess.`,
    `- data_sufficiency.band reflects how much MEANINGFUL input exists (weight high-importance attributes and real transcripts most): "Thin" (barely anything), "Developing", "Solid", "Rich".`,
    `- known_gaps: list the high-importance attributes still unknown or low-confidence that would most improve the read.`,
    `- next_action is GAP-DRIVEN when the profile is thin: say exactly what to find out and HOW to ask it (natural discovery questions tuned to the deal's likely archetype/tone). When the profile is rich, shift to the closing approach that fits them. Always concrete and rep-ready.`,
    `- When a PRIOR profile is supplied, RECONCILE: keep stable high-confidence reads, revise only where new evidence warrants, and raise confidence where new evidence corroborates. Note any change in your reasoning.`,
  ].join("\n");

  return {
    text,
    attrKeys: (attrs ?? []).map((a: any) => a.key),
    archKeys: (archs ?? []).map((a: any) => a.key),
  };
}

// ── Per-deal inputs ────────────────────────────────────────────────────────
interface DealInputs {
  header: string;
  transcripts: { at: string; text: string }[];
  notes: string[];
  adText: string;
  signalText: string;
  latestActivityAt: string | null;
  transcriptCount: number;
}

async function gatherDealInputs(db: SupabaseClient, dealId: string): Promise<DealInputs | null> {
  const { data: deal } = await db
    .from("crm_deals")
    .select("id, title, value_cents, status, created_at, interests, custom, crm_stages(name, crm_pipelines(name)), crm_contacts(id, name, tz_offset, emails)")
    .eq("id", dealId)
    .maybeSingle();
  if (!deal) return null;
  const c: any = (deal as any).crm_contacts;
  const stage: any = (deal as any).crm_stages;
  const email = (c?.emails ?? []).find((e: any) => e?.primary)?.value ?? (c?.emails ?? [])[0]?.value ?? null;

  const tzName = c?.tz_offset === -5 || c?.tz_offset === -4 ? "East" : c?.tz_offset === -6 ? "Central" : c?.tz_offset != null ? "West" : "unknown";
  const header = [
    `Deal: ${(deal as any).title}`,
    `Contact: ${c?.name ?? "—"} (region ${tzName})`,
    `Pipeline/Stage: ${stage?.crm_pipelines?.name ?? "—"} / ${stage?.name ?? "—"}`,
    (deal as any).value_cents != null && `Value: $${Math.round((deal as any).value_cents / 100).toLocaleString()}`,
    (deal as any).interests?.length && `Interests on file: ${(deal as any).interests.join(", ")}`,
    `Created: ${((deal as any).created_at ?? "").slice(0, 10)}`,
  ].filter(Boolean).join("\n");

  // Transcripts + notes.
  const { data: acts } = await db
    .from("crm_activities")
    .select("type, subject, body, occurred_at")
    .eq("deal_id", dealId)
    .order("occurred_at", { ascending: true });
  const transcripts: { at: string; text: string }[] = [];
  const notes: string[] = [];
  let latestActivityAt: string | null = null;
  for (const a of acts ?? []) {
    if (a.occurred_at && (!latestActivityAt || a.occurred_at > latestActivityAt)) latestActivityAt = a.occurred_at;
    const body = (a.body ?? "").trim();
    if (a.type === "call" && body.length > 120) transcripts.push({ at: a.occurred_at, text: body.slice(0, 4000) });
    else if ((a.type === "note" || a.type === "email") && body) notes.push(`[${(a.occurred_at ?? "").slice(0, 10)} ${a.subject ?? a.type}] ${body.slice(0, 500)}`);
  }

  // Ad interactions (with campaign/ad IDs) + engagement signals, keyed by email.
  let adText = "None recorded.";
  let signalText = "None recorded.";
  if (email) {
    const lower = email.toLowerCase();
    const [{ data: contactRow }, { data: evs }] = await Promise.all([
      db.from("crm_contacts").select("attribution").eq("id", c?.id ?? "").maybeSingle(),
      db.from("engagement_events").select("type, occurred_at").eq("person_email", lower).order("occurred_at", { ascending: false }).limit(80),
    ]);
    const touches: any[] = ((contactRow?.attribution as any)?.touches ?? []) as any[];
    if (touches.length) {
      adText = touches
        .slice(0, 25)
        .map((t) => [t.source, t.medium, t.campaign, t.content, t.adId && `ad:${t.adId}`, t.gclid && "gclid", t.fbclid && "fbclid"].filter(Boolean).join(" / "))
        .filter(Boolean)
        .join("\n");
    }
    const evCounts: Record<string, number> = {};
    for (const e of evs ?? []) evCounts[e.type] = (evCounts[e.type] ?? 0) + 1;
    if (Object.keys(evCounts).length)
      signalText = Object.entries(evCounts).map(([t, n]) => `${t}×${n}`).join(", ");
  }

  return { header, transcripts, notes, adText, signalText, latestActivityAt, transcriptCount: transcripts.length };
}

// ── Structured-output tool ─────────────────────────────────────────────────
const PROFILE_TOOL = {
  name: "record_deal_profile",
  description: "Record the structured buyer profile for this deal.",
  input_schema: {
    type: "object",
    properties: {
      archetypes: {
        type: "array",
        description: "Relevant archetypes with percentage fit, highest first. Omit archetypes with no real basis.",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            name: { type: "string" },
            pct: { type: "number" },
            confidence: { type: "number" },
            evidence: { type: "array", items: { type: "string" } },
          },
          required: ["key", "name", "pct", "confidence"],
        },
      },
      attributes: {
        type: "array",
        description: "Universal attributes the evidence supports. Use the attribute keys from the taxonomy.",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            value: { type: "string" },
            confidence: { type: "number" },
            evidence: { type: "array", items: { type: "string" } },
          },
          required: ["key", "value", "confidence"],
        },
      },
      summary: { type: "string", description: "2-4 sentence rep-facing read of who this buyer is." },
      next_action: {
        type: "object",
        properties: {
          action: { type: "string", description: "The single most valuable next move, concrete and rep-ready." },
          rationale: { type: "string" },
          questions_to_ask: {
            type: "array",
            description: "Natural discovery questions to fill the biggest gaps, phrased for this buyer's tone.",
            items: { type: "string" },
          },
          confidence: { type: "number" },
        },
        required: ["action", "rationale"],
      },
      data_sufficiency: {
        type: "object",
        properties: {
          band: { type: "string", enum: ["Thin", "Developing", "Solid", "Rich"] },
          coverage_note: { type: "string", description: "One line: what's known vs missing." },
          known_gaps: {
            type: "array",
            items: {
              type: "object",
              properties: { attribute: { type: "string" }, why: { type: "string" } },
              required: ["attribute"],
            },
          },
        },
        required: ["band", "coverage_note"],
      },
      overall_confidence: { type: "number", description: "0-1 overall confidence in this profile." },
    },
    required: ["archetypes", "attributes", "summary", "next_action", "data_sufficiency", "overall_confidence"],
  },
};

// ── Eligibility ────────────────────────────────────────────────────────────
export type ExtractOutcome = {
  ran: boolean;
  reason?: string;
  profile?: any;
  costCents?: number;
};

async function isEligible(
  db: SupabaseClient,
  dealId: string,
  cfg: AiProfilerConfig
): Promise<{ ok: boolean; reason?: string }> {
  const { data: deal } = await db
    .from("crm_deals")
    .select("status, value_cents, last_activity_at, crm_stages(crm_pipelines(name))")
    .eq("id", dealId)
    .maybeSingle();
  if (!deal) return { ok: false, reason: "deal not found" };
  if ((deal as any).status !== "open") return { ok: false, reason: "not an open deal (lost/won never profiled)" };
  const pipeline = (deal as any).crm_stages?.crm_pipelines?.name ?? "";
  if (cfg.pipelines.length && !cfg.pipelines.includes(pipeline)) return { ok: false, reason: `pipeline ${pipeline} out of scope` };
  if (cfg.min_value_cents != null && ((deal as any).value_cents ?? 0) < cfg.min_value_cents) return { ok: false, reason: "under min value" };
  if (cfg.active_days > 0) {
    const cutoff = new Date(Date.now() - cfg.active_days * 86_400_000).toISOString();
    if (!((deal as any).last_activity_at) || (deal as any).last_activity_at < cutoff) return { ok: false, reason: "not active recently" };
  }
  return { ok: true };
}

// ── The extraction ─────────────────────────────────────────────────────────
export async function extractProfile(
  db: SupabaseClient,
  dealId: string,
  opts: { force?: boolean; tier?: ModelTier } = {}
): Promise<ExtractOutcome> {
  const cfg = await loadAiConfig(db);
  if (!cfg.enabled && !opts.force) return { ran: false, reason: "profiler disabled" };

  const elig = await isEligible(db, dealId, cfg);
  if (!elig.ok && !opts.force) return { ran: false, reason: elig.reason };

  const inputs = await gatherDealInputs(db, dealId);
  if (!inputs) return { ran: false, reason: "no deal inputs" };
  if (cfg.require_transcript && inputs.transcriptCount === 0 && !opts.force)
    return { ran: false, reason: "no transcript yet (require_transcript on)" };

  // Prior profile + watermark → incremental delta.
  const { data: prior } = await db.from("deal_profiles").select("*").eq("deal_id", dealId).maybeSingle();
  const inputHash = `${inputs.transcriptCount}:${inputs.latestActivityAt ?? ""}:${inputs.notes.length}`;
  const wm = (prior?.watermark ?? {}) as any;
  if (prior && wm.input_hash === inputHash && !opts.force) {
    const debounceMs = cfg.debounce_hours * 3_600_000;
    if (prior.last_run_at && Date.now() - Date.parse(prior.last_run_at) < debounceMs)
      return { ran: false, reason: "no new signals since last run", profile: prior };
  }

  // Budget guard.
  if (!opts.force) {
    const spent = await monthToDateSpendCents(db);
    if (spent >= cfg.monthly_budget_cents) return { ran: false, reason: `monthly budget reached ($${(spent / 100).toFixed(2)})` };
  }

  const taxonomy = await buildTaxonomy(db);
  const tier = opts.tier ?? cfg.models.extract;

  // Incremental: when reconciling, send the prior read + only NEW transcripts.
  const priorAt = prior ? (wm.processed_at ?? null) : null;
  const newTranscripts = priorAt ? inputs.transcripts.filter((t) => t.at > priorAt) : inputs.transcripts;
  const transcriptsToSend = prior && newTranscripts.length ? newTranscripts : inputs.transcripts;

  const userParts = [
    `# DEAL\n${inputs.header}`,
    `\n# AD INTERACTIONS (source / medium / campaign / content / ad-id)\n${inputs.adText}`,
    `\n# ENGAGEMENT SIGNALS\n${inputs.signalText}`,
    inputs.notes.length ? `\n# NOTES\n${inputs.notes.slice(0, 12).join("\n")}` : "",
    transcriptsToSend.length
      ? `\n# CALL TRANSCRIPTS (${prior && newTranscripts.length ? "NEW since last profile" : "all"})\n` +
        transcriptsToSend.map((t, i) => `--- Call ${i + 1} (${(t.at ?? "").slice(0, 10)}) ---\n${t.text}`).join("\n\n")
      : "\n# CALL TRANSCRIPTS\nNone yet.",
  ];
  if (prior) {
    userParts.unshift(
      `# PRIOR PROFILE (reconcile against new evidence; keep stable high-confidence reads)\n` +
        JSON.stringify({ archetypes: prior.archetypes, attributes: prior.attributes, summary: prior.summary }).slice(0, 3000)
    );
  }

  const call = await callClaudeTool({
    tier,
    systemCached: taxonomy.text,
    user: userParts.filter(Boolean).join("\n"),
    tool: PROFILE_TOOL,
  });
  await logAiUsage(db, { dealId, task: prior ? "revalidate" : "extract", tier, call });

  const out = call.input;
  // Normalize attributes array → { key: {value, confidence, evidence} } map.
  const attrMap: Record<string, any> = {};
  for (const a of out.attributes ?? []) if (a.key) attrMap[a.key] = { value: a.value, confidence: a.confidence, evidence: a.evidence ?? [] };

  const row = {
    deal_id: dealId,
    attributes: attrMap,
    archetypes: (out.archetypes ?? []).sort((a: any, b: any) => (b.pct ?? 0) - (a.pct ?? 0)),
    summary: out.summary ?? null,
    next_action: out.next_action ?? null,
    overall_confidence: out.overall_confidence ?? null,
    watermark: { input_hash: inputHash, processed_at: inputs.latestActivityAt, transcript_ct: inputs.transcriptCount },
    status: "fresh",
    last_model: call.model,
    runs: (prior?.runs ?? 0) + 1,
    version: (prior?.version ?? 0) + 1,
    last_run_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    // data_sufficiency lives inside the returned JSON; store on the row too.
    ...(out.data_sufficiency ? { } : {}),
  };
  // Fold data_sufficiency into next_action-adjacent storage via attributes meta.
  const { error } = await db.from("deal_profiles").upsert(
    { ...row, next_action: { ...(out.next_action ?? {}), data_sufficiency: out.data_sufficiency } },
    { onConflict: "deal_id" }
  );
  if (error) return { ran: false, reason: `save failed: ${error.message}` };

  return { ran: true, profile: { ...row, next_action: { ...(out.next_action ?? {}), data_sufficiency: out.data_sufficiency } }, costCents: call.costCents };
}
