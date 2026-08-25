import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaudeTool, logAiUsage } from "./ai";
import {
  loadAiConfig,
  monthToDateSpendCents,
  type AiProfilerConfig,
  type ModelTier,
} from "./ai-profiler";
import { INTERESTS } from "@/app/components/interests";

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
    `## Primary interests (fixed catalog — output ONLY these exact labels)`,
    INTERESTS.join(" | "),
    `Interests already on the deal are REP-VERIFIED ground truth: weigh them heavily when scoring archetype fit and shaping next_action, and re-emit them. Add catalog interests the evidence supports; never guess. Interest-flavored specifics outside the catalog belong in tags instead.`,
    ``,
    `## Definitions (app-specific terms in the input)`,
    `Call dispositions (rep-logged outcome per dial): connected = live conversation; vm_dropped = left a voicemail; no_answer = rang out / ignored / mailbox full; bad_number = number doesn't reach them (struck from lists); callback = the buyer asked to be called at a set time (positive signal); confirmation = post-sale confirmation call.`,
    `Call classifications (system-detected): conversation = answered call; voicemail = our inbound VM system took a message; no_answer = missed.`,
    `Engagement signals: checkout_started / builder_save (3D camper builder) / added_to_cart = strong BUY-INTENT; click/open = marketing email interaction; funnel-touch notes ("🔁 … — funnel touch") are automated intake events, not rep conversations.`,
    ``,
    `## Rules`,
    `- ALWAYS fill EVERY field of the tool on EVERY run — archetypes, attributes, tags, summary, next_action (with questions_to_ask), data_sufficiency (with band), and overall_confidence. This is REQUIRED even when reconciling: re-emit unchanged values, never omit a field.`,
    `- EVERY attribute value and archetype fit MUST cite evidence, but keep evidence TERSE: at most 2-3 items, each a short phrase or brief quote (under ~12 words). No paragraphs. No evidence → don't assert it.`,
    `- tags: specific, concrete details the person mentioned that don't fit the fixed attributes — e.g. "surfing", "has two dogs", "just retired", "wife named Sara", "tows a boat", "lives in Bend". Short noun-phrases, lowercase, deduplicated. These are the memorable specifics a rep would want at a glance.`,
    `- confidence is 0.0-1.0. Be honest — thin or conflicting input means LOW confidence, not a confident guess.`,
    `- overall_confidence (0.0-1.0) is REQUIRED every run — your overall certainty in this profile given the evidence.`,
    `- data_sufficiency.band reflects how much MEANINGFUL input exists (weight high-importance attributes and real transcripts most): "Thin" (barely anything), "Developing", "Solid", "Rich". Always set it.`,
    `- known_gaps: list the high-importance attributes still unknown or low-confidence that would most improve the read.`,
    `- next_action is GAP-DRIVEN when the profile is thin: say exactly what to find out and HOW to ask it (natural discovery questions in questions_to_ask, tuned to the deal's likely archetype/tone). When the profile is rich, shift to the closing approach that fits them. Always concrete and rep-ready, and always include questions_to_ask that would raise confidence.`,
    `- When a PRIOR profile is supplied, RECONCILE: keep stable high-confidence reads, fold in the new evidence, raise confidence where it corroborates, and MERGE tags (keep prior tags, add new ones). Still output the COMPLETE profile with all fields populated.`,
  ].join("\n");

  return {
    text,
    attrKeys: (attrs ?? []).map((a: any) => a.key),
    archKeys: (archs ?? []).map((a: any) => a.key),
  };
}

// ── Per-deal inputs ────────────────────────────────────────────────────────
export interface DealInputs {
  header: string;
  transcripts: { at: string; text: string }[];
  notes: string[];
  adText: string;
  signalText: string;
  callText: string;
  interestsOnFile: string[];
  latestActivityAt: string | null;
  transcriptCount: number;
}

export async function gatherDealInputs(db: SupabaseClient, dealId: string): Promise<DealInputs | null> {
  const { data: deal } = await db
    .from("crm_deals")
    .select("id, pipedrive_deal_id, title, value_cents, status, created_at, interests, custom, crm_stages(name, crm_pipelines(name)), crm_contacts(id, name, tz_offset, emails)")
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
  // latestActivityAt tracks CONTENT the model actually reads (transcripts +
  // note/email bodies) — NOT every timeline write. Call stubs, scheduled
  // follow-ups, and system rows used to bump it, changing the input hash and
  // re-running a full extraction with nothing new to say.
  let latestActivityAt: string | null = null;
  for (const a of acts ?? []) {
    const body = (a.body ?? "").trim();
    const isTranscript = a.type === "call" && body.length > 120;
    const isNote = (a.type === "note" || a.type === "email") && !!body;
    if (isTranscript) transcripts.push({ at: a.occurred_at, text: body.slice(0, 4000) });
    else if (isNote) notes.push(`[${(a.occurred_at ?? "").slice(0, 10)} ${a.subject ?? a.type}] ${body.slice(0, 500)}`);
    if ((isTranscript || isNote) && a.occurred_at && (!latestActivityAt || a.occurred_at > latestActivityAt)) {
      latestActivityAt = a.occurred_at;
    }
  }

  // Telnyx-era transcripts live in call_events.raw->transcript (Deepgram) and
  // never become activity bodies — the Quo-era pipeline wrote transcripts into
  // crm_activities, this one doesn't. Quo-era call_events deliberately carry
  // no transcript text, so this source is purely additive (no double-count).
  {
    const pdIdForCalls = (deal as any).pipedrive_deal_id;
    const orExpr = pdIdForCalls != null ? `crm_deal_id.eq.${dealId},deal_id.eq.${pdIdForCalls}` : `crm_deal_id.eq.${dealId}`;
    const { data: ceTr } = await db
      .from("call_events")
      .select("started_at, transcript:raw->>transcript")
      .or(orExpr)
      .order("started_at", { ascending: true })
      .limit(200);
    for (const ce of ceTr ?? []) {
      const text = String((ce as any).transcript ?? "").trim();
      if (text.length <= 120 || !ce.started_at) continue;
      transcripts.push({ at: ce.started_at, text: text.slice(0, 4000) });
      if (!latestActivityAt || ce.started_at > latestActivityAt) latestActivityAt = ce.started_at;
    }
    transcripts.sort((a, b) => (a.at < b.at ? -1 : 1));
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

  // Call-outcome history (dispositions defined in the system prompt). Kept
  // OUT of the input hash — a new dial shouldn't re-run extraction by itself,
  // but the history rides along whenever a contentful run happens.
  let callText = "No calls yet.";
  const pdId = (deal as any).pipedrive_deal_id;
  if (pdId != null) {
    const { data: calls } = await db
      .from("call_events")
      .select("disposition, classification, duration_s, started_at")
      .eq("deal_id", pdId)
      .order("started_at", { ascending: false })
      .limit(100);
    if (calls?.length) {
      const counts: Record<string, number> = {};
      let talkS = 0;
      for (const cl of calls) {
        const k = cl.disposition ?? cl.classification ?? "unknown";
        counts[k] = (counts[k] ?? 0) + 1;
        talkS += cl.duration_s ?? 0;
      }
      callText = `${calls.length} dials — ${Object.entries(counts).map(([k, n]) => `${k}×${n}`).join(", ")}; total talk ${Math.round(talkS / 60)}m; last ${(calls[0].started_at ?? "").slice(0, 10)}`;
    }
  }

  return {
    header,
    transcripts,
    notes,
    adText,
    signalText,
    callText,
    interestsOnFile: ((deal as any).interests ?? []) as string[],
    latestActivityAt,
    transcriptCount: transcripts.length,
  };
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
      tags: {
        type: "array",
        description: "Specific concrete details the person mentioned that don't fit the fixed attributes (e.g. 'surfing', 'has two dogs', 'tows a boat', 'lives in Bend'). Short lowercase noun-phrases, deduplicated. Merge with prior tags on reconcile.",
        items: { type: "string" },
      },
      interests: {
        type: "array",
        description: "Primary interests from the FIXED catalog only (exact labels). Re-emit the rep-verified ones already on file plus any new ones the evidence supports.",
        items: { type: "string" },
      },
      summary: { type: "string", description: "2-4 sentence rep-facing read of who this buyer is." },
      next_action: {
        type: "object",
        properties: {
          action: { type: "string", description: "The single most valuable next move, concrete and rep-ready." },
          rationale: { type: "string" },
          questions_to_ask: {
            type: "array",
            description: "REQUIRED: natural discovery questions that would raise confidence / fill the biggest gaps, phrased for this buyer's tone. Always include at least one.",
            items: { type: "string" },
          },
          confidence: { type: "number" },
        },
        required: ["action", "rationale", "questions_to_ask"],
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
      overall_confidence: { type: "number", description: "REQUIRED 0-1 overall confidence in this profile (never omit)." },
    },
    required: ["archetypes", "attributes", "tags", "summary", "next_action", "data_sufficiency", "overall_confidence"],
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
  opts: { force?: boolean; manual?: boolean; tier?: ModelTier } = {}
): Promise<ExtractOutcome> {
  const cfg = await loadAiConfig(db);
  // `manual` = an explicit user request (the button): runs even when auto is
  // off, ignoring scope/debounce/require-transcript — but still respects the
  // budget and never profiles a lost/won deal. `force` = admin/cron override.
  const bypass = opts.force || opts.manual;
  if (!cfg.enabled && !bypass) return { ran: false, reason: "profiler disabled" };

  const elig = await isEligible(db, dealId, cfg);
  // Lost/won is a hard rule (only a raw force bypasses it, for testing).
  if (!elig.ok) {
    if (opts.force) {
      /* testing override */
    } else if (opts.manual && elig.reason?.startsWith("not an open deal")) {
      return { ran: false, reason: elig.reason };
    } else if (!opts.manual) {
      return { ran: false, reason: elig.reason };
    }
  }

  const inputs = await gatherDealInputs(db, dealId);
  if (!inputs) return { ran: false, reason: "no deal inputs" };
  if (cfg.require_transcript && inputs.transcriptCount === 0 && !bypass)
    return { ran: false, reason: "no transcript yet (require_transcript on)" };

  // Prior profile + watermark → incremental delta.
  const { data: prior } = await db.from("deal_profiles").select("*").eq("deal_id", dealId).maybeSingle();
  const inputHash = `${inputs.transcriptCount}:${inputs.latestActivityAt ?? ""}:${inputs.notes.length}`;
  const wm = (prior?.watermark ?? {}) as any;
  // No new signals → ALWAYS skip (free), regardless of how long ago the last
  // run was. (This used to fall through once debounce_hours passed, silently
  // re-running a full extraction on IDENTICAL inputs every deal open.)
  if (prior && wm.input_hash === inputHash && !opts.force) {
    return {
      ran: false,
      reason: opts.manual ? "already current — no new signals to add" : "no new signals since last run",
      profile: prior,
    };
  }
  // New info + a very recent run → debounce the auto path (the 20-min
  // background refresh folds it in once the window passes). Manual/force run now.
  if (prior && !bypass) {
    const debounceMs = cfg.debounce_hours * 3_600_000;
    if (prior.last_run_at && Date.now() - Date.parse(prior.last_run_at) < debounceMs)
      return { ran: false, reason: "debounced — new activity folds in on the next background refresh", profile: prior };
  }

  // Budget guard (manual respects it; only a raw force bypasses).
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
    `\n# CALL HISTORY (outcome counts — see Definitions)\n${inputs.callText}`,
    inputs.notes.length ? `\n# NOTES\n${inputs.notes.slice(0, 12).join("\n")}` : "",
    transcriptsToSend.length
      ? `\n# CALL TRANSCRIPTS (${prior && newTranscripts.length ? "NEW since last profile" : "all"})\n` +
        transcriptsToSend.map((t, i) => `--- Call ${i + 1} (${(t.at ?? "").slice(0, 10)}) ---\n${t.text}`).join("\n\n")
      : "\n# CALL TRANSCRIPTS\nNone yet.",
  ];
  // Rep corrections are authoritative — the model is told, AND the output is
  // hard-enforced after the call (belt and suspenders).
  const corr = (prior?.corrections ?? {}) as {
    archetypes_wrong?: string[];
    attributes_cleared?: string[];
    tags_removed?: string[];
    interests_removed?: string[];
    notes?: { text: string; by: string; at: string }[];
  };
  const corrLines = [
    corr.archetypes_wrong?.length && `- NOT these archetypes (rep marked wrong): ${corr.archetypes_wrong.join(", ")} — exclude them.`,
    corr.attributes_cleared?.length && `- Do NOT assert these attributes (rep cleared them as wrong): ${corr.attributes_cleared.join(", ")}.`,
    corr.tags_removed?.length && `- Never re-add these tags: ${corr.tags_removed.join(", ")}.`,
    corr.interests_removed?.length && `- Never re-add these interests: ${corr.interests_removed.join(", ")}.`,
    ...(corr.notes ?? []).slice(-10).map(
      (n) => `- Rep note (${(n.at ?? "").slice(0, 10)}): "${String(n.text).slice(0, 300)}" — treat as verified fact; reinterpret other evidence in its light.`
    ),
  ].filter(Boolean) as string[];
  if (corrLines.length) {
    userParts.unshift(`# REP CORRECTIONS (authoritative — a human verified these; never contradict)\n${corrLines.join("\n")}`);
  }
  if (prior) {
    userParts.unshift(
      `# PRIOR PROFILE (reconcile against new evidence; keep stable high-confidence reads; MERGE tags; re-emit ALL fields)\n` +
        JSON.stringify({
          archetypes: prior.archetypes,
          attributes: prior.attributes,
          tags: prior.tags,
          summary: prior.summary,
          next_action: prior.next_action,
          overall_confidence: prior.overall_confidence,
        }).slice(0, 4000)
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
  // Normalize attributes array → { key: {value, confidence, evidence} } map,
  // enforcing rep corrections: cleared attributes never re-assert.
  const clearedSet = new Set(corr.attributes_cleared ?? []);
  const attrMap: Record<string, any> = {};
  for (const a of out.attributes ?? []) {
    if (a.key && !clearedSet.has(a.key)) attrMap[a.key] = { value: a.value, confidence: a.confidence, evidence: a.evidence ?? [] };
  }

  // Merge tags with the prior set (belt-and-suspenders — the model is also
  // told to merge). Dedup, lowercase, cap; rep-removed tags never return.
  const removedTags = new Set((corr.tags_removed ?? []).map((t) => t.toLowerCase()));
  const priorTags: string[] = Array.isArray(prior?.tags) ? prior!.tags : [];
  const tags = [...new Set([...priorTags, ...((out.tags ?? []) as string[])].map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
    .filter((t) => !removedTags.has(t))
    .slice(0, 40);

  // Rep-marked-wrong archetypes are hard-excluded no matter what came back.
  const wrongSet = new Set(corr.archetypes_wrong ?? []);
  if (Array.isArray(out.archetypes)) out.archetypes = out.archetypes.filter((a: any) => !wrongSet.has(a.key));

  // Carry forward confidence / data_sufficiency if a reconcile omitted them,
  // so an incremental run never blanks out fields the deal already had.
  const nextAction = { ...(out.next_action ?? prior?.next_action ?? {}), data_sufficiency: out.data_sufficiency ?? prior?.next_action?.data_sufficiency };
  const overallConfidence = out.overall_confidence ?? prior?.overall_confidence ?? null;

  const row = {
    deal_id: dealId,
    attributes: Object.keys(attrMap).length ? attrMap : (prior?.attributes ?? {}),
    archetypes: ((out.archetypes?.length ? out.archetypes : prior?.archetypes ?? []) as any[])
      .filter((a: any) => !wrongSet.has(a.key))
      .sort((a: any, b: any) => (b.pct ?? 0) - (a.pct ?? 0)),
    tags,
    summary: out.summary ?? prior?.summary ?? null,
    next_action: nextAction,
    overall_confidence: overallConfidence,
    watermark: { input_hash: inputHash, processed_at: inputs.latestActivityAt, transcript_ct: inputs.transcriptCount },
    status: "fresh",
    last_model: call.model,
    runs: (prior?.runs ?? 0) + 1,
    version: (prior?.version ?? 0) + 1,
    last_run_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from("deal_profiles").upsert(row, { onConflict: "deal_id" });
  if (error) return { ran: false, reason: `save failed: ${error.message}` };

  // Write interests back to the deal: UNION of what's on file (rep-verified —
  // never removed) and the model's catalog-validated picks. Interests a rep
  // explicitly removed stay removed.
  const blockedInterests = new Set(corr.interests_removed ?? []);
  const validPicks = ((out.interests ?? []) as string[]).filter(
    (i) => (INTERESTS as readonly string[]).includes(i) && !blockedInterests.has(i)
  );
  const merged = [...new Set([...inputs.interestsOnFile, ...validPicks])];
  if (merged.length > inputs.interestsOnFile.length) {
    await db.from("crm_deals").update({ interests: merged, updated_at: new Date().toISOString() }).eq("id", dealId);
  }

  return { ran: true, profile: row, costCents: call.costCents };
}
