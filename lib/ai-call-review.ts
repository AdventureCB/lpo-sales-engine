import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaudeTool, logAiUsage } from "./ai";
import { loadAiConfig, monthToDateSpendCents } from "./ai-profiler";
import { gatherDealInputs } from "./ai-profiler-engine";

/**
 * Call review — StoryBrand coaching on ONE call, judged against what the
 * deal's AI profile knew at review time. Manual-only (button press), cached
 * in call_reviews keyed by transcript hash + profile version, so a re-press
 * costs nothing. Until the port completes most transcripts are Quo SUMMARIES —
 * the model flags that (thin_transcript) and keeps feedback high-level.
 *
 * runRepPatterns aggregates stored reviews into per-rep coaching patterns
 * (recurring strengths/gaps) — admin-triggered, useful once reviews accumulate.
 */

const COMPANY =
  "Lone Peak Overland (LPO) sells the Lone Peak Camper — a made-to-order pop-up wedge truck-bed camper (from $7k, ~400 lb, 15-second setup) plus power/solar, heating, and gear accessories.";

const SCORECARD_PRINCIPLES = ["Guide positioning", "Problem articulation", "Simple plan", "Clear CTA", "Discovery"];

const REVIEW_TOOL = {
  name: "record_call_review",
  description: "Record the structured coaching review for this call.",
  input_schema: {
    type: "object",
    properties: {
      snapshot: { type: "string", description: "2-3 sentence verdict: what the call was and how it went." },
      worked: {
        type: "array",
        items: { type: "string" },
        description: "Specific moments that worked, quoting the call where possible. Omit if nothing stands out.",
      },
      scorecard: {
        type: "array",
        items: {
          type: "object",
          properties: {
            principle: { type: "string", enum: SCORECARD_PRINCIPLES },
            verdict: { type: "string", enum: ["hit", "partial", "missed"] },
            note: { type: "string", description: "One line of evidence from the call." },
          },
          required: ["principle", "verdict", "note"],
        },
        description: "One entry per principle — all five, in order.",
      },
      do_differently: {
        type: "array",
        items: {
          type: "object",
          properties: {
            moment: { type: "string", description: "The moment in the call this applies to." },
            try: { type: "string", description: "A concrete alternative line, wrapped in *italics* as speech." },
          },
          required: ["moment", "try"],
        },
        description: "2-3 concrete alternatives tied to what the buyer profile knows about this person.",
      },
      next_move: { type: "string", description: "Suggested next move on this deal given how the call went." },
      thin_transcript: { type: "boolean", description: "true when the input reads as a brief summary rather than a full transcript." },
    },
    required: ["snapshot", "scorecard", "next_move", "thin_transcript"],
  },
};

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function budgetOk(db: SupabaseClient, capCents: number): Promise<boolean> {
  return (await monthToDateSpendCents(db)) < capCents;
}

function profileBlock(profile: any): string {
  if (!profile) return "No AI profile yet — coach from the transcript alone.";
  return JSON.stringify(
    {
      summary: profile.summary,
      archetypes: (profile.archetypes ?? []).slice(0, 3),
      attributes: profile.attributes,
      tags: profile.tags,
      interests: profile.interests,
      next_action: profile.next_action?.action,
    },
    null,
    0
  ).slice(0, 3500);
}

function correctionsBlock(profile: any): string | null {
  const corr = (profile?.corrections ?? {}) as {
    archetypes_wrong?: string[];
    attributes_cleared?: string[];
    tags_removed?: string[];
    notes?: { text: string; at: string }[];
  };
  const lines = [
    corr.archetypes_wrong?.length && `- NOT these archetypes (rep marked wrong): ${corr.archetypes_wrong.join(", ")}`,
    corr.attributes_cleared?.length && `- These attributes were cleared as wrong: ${corr.attributes_cleared.join(", ")}`,
    ...(corr.notes ?? []).slice(-5).map((n) => `- Rep note (${(n.at ?? "").slice(0, 10)}): "${String(n.text).slice(0, 300)}"`),
  ].filter(Boolean) as string[];
  return lines.length ? lines.join("\n") : null;
}

export async function reviewCall(
  db: SupabaseClient,
  opts: { dealId: string; activityId?: string | null; quoCallId?: string | null; force?: boolean }
): Promise<{ ok: boolean; reason?: string; review?: any; cached?: boolean; reviewedAt?: string }> {
  const cfg = await loadAiConfig(db);

  // ── Transcript + call facts (two sources; see header comment) ────────────
  let transcript = "";
  let rep: string | null = null;
  const facts: string[] = [];
  if (opts.activityId) {
    const { data: a } = await db
      .from("crm_activities")
      .select("id, type, subject, body, actor, occurred_at")
      .eq("id", opts.activityId)
      .maybeSingle();
    if (!a || a.type !== "call") return { ok: false, reason: "call activity not found" };
    transcript = (a.body ?? "").trim();
    if (a.subject) facts.push(a.subject);
    if (a.occurred_at) facts.push(`on ${a.occurred_at.slice(0, 10)}`);
    if (a.actor && a.actor.includes("@")) {
      const { data: u } = await db.from("app_users").select("email, reps ( name )").eq("email", a.actor).maybeSingle();
      rep = (u?.reps as any)?.name ?? a.actor.split("@")[0];
    }
  } else if (opts.quoCallId) {
    const { data: c } = await db
      .from("call_events")
      .select("quo_call_id, direction, duration_s, started_at, disposition, classification, transcript:raw->>transcript, reps ( name )")
      .eq("quo_call_id", opts.quoCallId)
      .maybeSingle();
    if (!c) return { ok: false, reason: "call not found" };
    transcript = String((c as any).transcript ?? "").trim();
    facts.push(c.direction === "incoming" ? "Inbound call" : "Outbound call");
    if (c.duration_s) facts.push(`${Math.floor(c.duration_s / 60)}m ${c.duration_s % 60}s`);
    if (c.disposition ?? c.classification) facts.push(String(c.disposition ?? c.classification));
    if (c.started_at) facts.push(`on ${c.started_at.slice(0, 10)}`);
    rep = (c as any).reps?.name ?? null;
  } else {
    return { ok: false, reason: "activityId or callId required" };
  }
  if (transcript.length < 80) return { ok: false, reason: "no reviewable transcript on this call" };

  // ── Cache: same transcript + same profile version → return stored ────────
  const { data: profile } = await db.from("deal_profiles").select("*").eq("deal_id", opts.dealId).maybeSingle();
  const version = profile?.version ?? 0;
  const inputHash = `${hashStr(transcript)}:${version}`;
  const idCol = opts.activityId ? "activity_id" : "quo_call_id";
  const idVal = (opts.activityId ?? opts.quoCallId) as string;
  const { data: existing } = await db.from("call_reviews").select("*").eq(idCol, idVal).maybeSingle();
  if (existing && existing.input_hash === inputHash && !opts.force) {
    return { ok: true, review: existing.review, cached: true, reviewedAt: existing.updated_at };
  }

  if (!(await budgetOk(db, cfg.monthly_budget_cents))) return { ok: false, reason: "monthly AI budget reached" };
  const inputs = await gatherDealInputs(db, opts.dealId);
  if (!inputs) return { ok: false, reason: "deal not found" };

  const tier = cfg.models.review ?? "sonnet";
  const corrText = correctionsBlock(profile);
  const call = await callClaudeTool({
    tier,
    systemCached: [
      COMPANY,
      `You are a supportive sales-call coach for LPO reps, grounded in StoryBrand: the BUYER is the hero on a quest; the rep is the GUIDE (empathy + authority); articulate the buyer's external problem and what it means to them internally; give a SIMPLE PLAN; land ONE clear call to action; use discovery to fill profile gaps. You review ONE call against what the deal's AI buyer profile knew, and produce specific, actionable coaching — direct but kind, never scolding. Quote the actual call wherever possible.`,
      `Score all five principles: ${SCORECARD_PRINCIPLES.join(" / ")}. "hit" = clearly done well, "partial" = attempted but weak, "missed" = absent when it mattered. A short call (voicemail, quick reschedule) can legitimately miss principles — say so in the note without piling on.`,
      `REP CORRECTIONS in the profile are human-verified truth. Never mark the rep down for contradicting an AI guess a human corrected.`,
      `FORMATTING (the card renders these): wrap the 1-2 LOAD-BEARING words of a line in **double asterisks**; wrap anything spoken (by customer OR the suggested rep line) in *single asterisks*. Never bold whole sentences.`,
      `If the transcript reads as a brief summary rather than a real transcript (common until our phone-system port completes), set thin_transcript=true, keep feedback high-level, and NEVER invent specific quotes.`,
    ].join("\n\n"),
    user: [
      `# BUYER PROFILE (state at review time)\n${profileBlock(profile)}`,
      corrText ? `\n# REP CORRECTIONS (authoritative)\n${corrText}` : "",
      `\n# DEAL\n${inputs.header}`,
      `\n# CALL HISTORY\n${inputs.callText}`,
      `\n# THIS CALL${rep ? ` (rep: ${rep})` : ""}\n${facts.join(" · ") || "—"}`,
      `\n# TRANSCRIPT\n${transcript.slice(0, 15000)}`,
    ].join("\n"),
    tool: REVIEW_TOOL,
    maxTokens: 1200,
  });
  await logAiUsage(db, { dealId: opts.dealId, task: "call_review", tier, call });

  const now = new Date().toISOString();
  const row = {
    deal_id: opts.dealId,
    activity_id: opts.activityId ?? null,
    quo_call_id: opts.quoCallId ?? null,
    rep,
    input_hash: inputHash,
    profile_version: version,
    transcript_chars: transcript.length,
    model: tier,
    review: call.input,
    updated_at: now,
  };
  // Partial unique indexes can't take PostgREST onConflict — select-then-write.
  if (existing) await db.from("call_reviews").update(row).eq("id", existing.id);
  else await db.from("call_reviews").insert(row);
  return { ok: true, review: call.input, reviewedAt: now };
}

// ── Per-rep patterns rollup ─────────────────────────────────────────────────
const PATTERNS_TOOL = {
  name: "record_rep_patterns",
  description: "Record recurring coaching patterns for one rep across their reviewed calls.",
  input_schema: {
    type: "object",
    properties: {
      strengths: {
        type: "array",
        items: { type: "string" },
        description: "Recurring strengths — only patterns seen in 2+ calls, each one line with **bold** key words.",
      },
      gaps: {
        type: "array",
        items: { type: "string" },
        description: "Recurring gaps — only patterns seen in 2+ calls, each one line, specific and kind.",
      },
      coaching_focus: {
        type: "string",
        description: "The ONE thing to work on next, with a concrete practice suggestion (a line to try, in *italics*).",
      },
    },
    required: ["strengths", "gaps", "coaching_focus"],
  },
};

export async function runRepPatterns(
  db: SupabaseClient,
  opts: { windowDays?: number; minReviews?: number } = {}
): Promise<{ rep: string; reviews: number; ran: boolean; reason?: string }[]> {
  const cfg = await loadAiConfig(db);
  const windowDays = opts.windowDays ?? 90;
  const minReviews = opts.minReviews ?? 3;
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const { data: rows } = await db
    .from("call_reviews")
    .select("rep, review, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);

  const byRep = new Map<string, { review: any; created_at: string }[]>();
  for (const r of rows ?? []) {
    if (!r.rep) continue;
    const arr = byRep.get(r.rep) ?? [];
    if (arr.length < 30) arr.push(r); // newest 30 per rep is plenty of signal
    byRep.set(r.rep, arr);
  }

  const tier = cfg.models.review ?? "sonnet";
  const results: { rep: string; reviews: number; ran: boolean; reason?: string }[] = [];
  for (const [rep, reviews] of byRep) {
    if (reviews.length < minReviews) {
      results.push({ rep, reviews: reviews.length, ran: false, reason: `needs ${minReviews}+ reviews` });
      continue;
    }
    if (!(await budgetOk(db, cfg.monthly_budget_cents))) {
      results.push({ rep, reviews: reviews.length, ran: false, reason: "monthly AI budget reached" });
      continue;
    }
    // Scorecard tallies are arithmetic — computed here, not asked of the model.
    const tallies: Record<string, { hit: number; partial: number; missed: number }> = {};
    for (const r of reviews) {
      for (const s of r.review?.scorecard ?? []) {
        const t = (tallies[s.principle] ??= { hit: 0, partial: 0, missed: 0 });
        if (s.verdict === "hit" || s.verdict === "partial" || s.verdict === "missed") t[s.verdict as "hit"]++;
      }
    }
    const compact = reviews.map((r) => ({
      at: (r.created_at ?? "").slice(0, 10),
      snapshot: r.review?.snapshot,
      scorecard: (r.review?.scorecard ?? []).map((s: any) => `${s.principle}: ${s.verdict}`),
      do_differently: (r.review?.do_differently ?? []).map((d: any) => d.moment),
    }));
    try {
      const call = await callClaudeTool({
        tier,
        systemCached: [
          COMPANY,
          `You synthesize recurring coaching patterns for ONE sales rep from their reviewed calls (StoryBrand-scored). Report ONLY patterns that recur across 2+ calls — never generalize from a single call. Direct but kind; this is read by the rep and their manager.`,
          `FORMATTING: **bold** the 1-2 key words of each line; wrap suggested spoken lines in *italics*.`,
        ].join("\n\n"),
        user: `Rep: ${rep}\nReviewed calls (newest first):\n${JSON.stringify(compact).slice(0, 12000)}`,
        tool: PATTERNS_TOOL,
        maxTokens: 800,
      });
      await logAiUsage(db, { dealId: null, task: "rep_patterns", tier, call });
      await db.from("rep_call_patterns").upsert(
        {
          rep,
          review_count: reviews.length,
          window_days: windowDays,
          patterns: { ...call.input, scorecard_tallies: tallies },
          model: tier,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "rep" }
      );
      results.push({ rep, reviews: reviews.length, ran: true });
    } catch (e) {
      results.push({ rep, reviews: reviews.length, ran: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
