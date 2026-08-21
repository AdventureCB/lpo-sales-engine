import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaudeTool, logAiUsage } from "./ai";
import { loadAiConfig, monthToDateSpendCents } from "./ai-profiler";

/**
 * Draft & theme review — the taxonomy-critic pattern applied to generation:
 * digest the draft_events ledger (use rates, edit similarity, 👎 notes) and
 * PROPOSE bounded changes — theme edits/adds/retires and capped style rules.
 * Nothing self-applies; every proposal is human-approved on /settings/comms.
 * Run manually (button), designed to usually return "no changes warranted".
 */

const MAX_PROPOSALS = 8;
const MAX_ACTIVE_STYLE_RULES = 10;

const REVIEW_TOOL = {
  name: "record_draft_proposals",
  description: "Record proposed changes to draft themes and style rules.",
  input_schema: {
    type: "object",
    properties: {
      proposals: {
        type: "array",
        maxItems: MAX_PROPOSALS,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["theme_edit", "theme_add", "theme_retire", "style_add", "style_retire"] },
            target_key: { type: "string", description: "theme key (theme_*), or style-rule id (style_retire). Omit for style_add. theme_add: a NEW snake_case key not in the catalog." },
            proposed: {
              type: "object",
              description:
                "theme_*: any of {name, intent, prompt_direction, channels, sort_order}. style_add: {channel: all|email|sms|call, rule}. style_retire: {}.",
            },
            rationale: { type: "string", description: "One or two sentences, grounded in the evidence." },
            evidence: { type: "string", description: "The specific numbers/notes this rests on." },
          },
          required: ["kind", "proposed", "rationale"],
        },
      },
      no_changes_reason: { type: "string", description: "When proposing nothing: why the evidence doesn't warrant changes yet." },
    },
    required: ["proposals"],
  },
};

async function gatherEvidence(db: SupabaseClient) {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const [{ data: events }, { data: themes }, { data: rules }, { data: reviews }] = await Promise.all([
    db.from("draft_events").select("kind, theme_key, direction, used_at, thumbs, thumbs_note, sent_activity_id, sent_similarity, generated_at").gte("generated_at", since).limit(2000),
    db.from("comm_themes").select("key, name, intent, prompt_direction, channels, enabled"),
    db.from("draft_style_rules").select("id, channel, rule, enabled").order("created_at"),
    db.from("call_reviews").select("review").gte("created_at", since).limit(500),
  ]);

  type Agg = { generated: number; used: number; sent: number; simSum: number; simN: number; down: number; notes: string[] };
  const byTheme = new Map<string, Agg>();
  const dirSamples: string[] = [];
  const script = { generated: 0, down: 0, notes: [] as string[] };
  for (const e of events ?? []) {
    // Call-script rows feed the script section, not the theme table.
    if (e.kind === "call") {
      if (e.generated_at) script.generated++;
      if (e.thumbs === "down") {
        script.down++;
        if (e.thumbs_note && script.notes.length < 10) script.notes.push(e.thumbs_note);
      }
      continue;
    }
    const k = e.theme_key ?? "(auto)";
    const a = byTheme.get(k) ?? { generated: 0, used: 0, sent: 0, simSum: 0, simN: 0, down: 0, notes: [] };
    a.generated++;
    if (e.used_at) a.used++;
    if (e.sent_activity_id) a.sent++;
    if (e.sent_similarity != null) {
      a.simSum += e.sent_similarity;
      a.simN++;
    }
    if (e.thumbs === "down") {
      a.down++;
      if (e.thumbs_note && a.notes.length < 8) a.notes.push(e.thumbs_note);
    }
    byTheme.set(k, a);
    // Freeform directions reps keep typing = themes the catalog is missing.
    if (e.direction && dirSamples.length < 30) dirSamples.push(e.direction.slice(0, 120));
  }

  // How real calls scored on the StoryBrand principles (⚖ reviews) — the
  // outcome signal for call-script style rules.
  const scorecard: Record<string, { hit: number; partial: number; missed: number }> = {};
  for (const r of reviews ?? []) {
    for (const s of (r.review as any)?.scorecard ?? []) {
      const t = (scorecard[s.principle] ??= { hit: 0, partial: 0, missed: 0 });
      if (s.verdict === "hit" || s.verdict === "partial" || s.verdict === "missed") t[s.verdict as "hit"]++;
    }
  }

  const themeLines = [...byTheme.entries()]
    .map(([k, a]) => {
      const sim = a.simN ? ` avg-sent-similarity ${(a.simSum / a.simN).toFixed(2)}` : "";
      const notes = a.notes.length ? ` 👎notes: ${a.notes.map((n) => `"${n}"`).join(" | ")}` : "";
      return `- ${k}: generated ${a.generated}, used ${a.used}, sent ${a.sent}, 👎 ${a.down}.${sim}${notes}`;
    })
    .join("\n");

  return {
    totalEvents: (events ?? []).length,
    themes: themes ?? [],
    rules: rules ?? [],
    text: [
      `# DRAFT USAGE (last 60d, ${(events ?? []).length} drafts)`,
      themeLines || "(no drafts generated yet)",
      ``,
      `# CALL SCRIPTS (last 60d)`,
      `- generated ${script.generated}, 👎 ${script.down}${script.notes.length ? ` — notes: ${script.notes.map((n) => `"${n}"`).join(" | ")}` : ""}`,
      ``,
      `# CALL REVIEW SCORECARD (${(reviews ?? []).length} reviewed calls — how real calls scored on the StoryBrand principles the scripts teach)`,
      Object.keys(scorecard).length
        ? Object.entries(scorecard).map(([p, v]) => `- ${p}: hit ${v.hit} / partial ${v.partial} / missed ${v.missed}`).join("\n")
        : "(no reviewed calls yet)",
      ``,
      `# FREEFORM DIRECTIONS reps typed (signals for missing themes)`,
      dirSamples.length ? dirSamples.map((d) => `- "${d}"`).join("\n") : "(none)",
      ``,
      `# CURRENT THEME CATALOG`,
      (themes ?? []).map((t) => `- [${t.enabled ? "on" : "OFF"}] ${t.key} "${t.name}" (${(t.channels ?? []).join("/")}): ${t.prompt_direction}`).join("\n"),
      ``,
      `# CURRENT STYLE RULES (${(rules ?? []).filter((r) => r.enabled).length}/${MAX_ACTIVE_STYLE_RULES} active)`,
      (rules ?? []).map((r) => `- [${r.enabled ? "on" : "OFF"}] id=${r.id} (${r.channel}): ${r.rule}`).join("\n") || "(none)",
    ].join("\n"),
  };
}

export async function runDraftReview(db: SupabaseClient): Promise<{ ok: boolean; reason?: string; proposals?: number; noChanges?: string }> {
  const cfg = await loadAiConfig(db);
  if ((await monthToDateSpendCents(db)) >= cfg.monthly_budget_cents) return { ok: false, reason: "monthly AI budget reached" };
  const ev = await gatherEvidence(db);
  if (ev.totalEvents < 10) return { ok: false, reason: `only ${ev.totalEvents} drafts logged — need ~10+ before a review is meaningful` };

  const tier = cfg.models.critic ?? "sonnet";
  const call = await callClaudeTool({
    tier,
    systemCached: [
      `You are the draft-generation critic for Lone Peak Overland's sales engine. You review how AI email/text drafts AND call-script outlines actually performed — use rates, how heavily reps edited drafts before sending, thumbs-down notes, freeform directions reps keep typing, and how real calls scored on the StoryBrand principles the scripts teach — and propose MEANINGFUL, BOUNDED changes.`,
      `EVIDENCE THRESHOLDS (hard rules): theme_edit/theme_retire only with ≥8 generates for that theme; style_add only when ≥3 independent signals point the same way (similar 👎 notes, or consistently low sent-similarity with a visible pattern); theme_add only when ≥3 freeform directions ask for essentially the same missing angle; call-channel style rules only with ≥10 reviewed calls AND a principle missing ≥40% of the time (or ≥3 aligned script 👎 notes). Below threshold → propose nothing for it.`,
      `CONSTRAINTS: at most ${MAX_PROPOSALS} proposals; theme keys are immutable (edit fields, never keys); theme_add keys must be new snake_case; at most ${MAX_ACTIVE_STYLE_RULES} style rules may be active — if full, a style_add MUST be paired with a style_retire (target_key = the rule id). Style rules are one imperative sentence each. Most runs should return an empty proposals list with no_changes_reason — churn is worse than imperfection.`,
    ].join("\n\n"),
    user: ev.text.slice(0, 20_000),
    tool: REVIEW_TOOL,
    maxTokens: 1500,
  });
  await logAiUsage(db, { dealId: null, task: "draft_review", tier, call });

  const proposals = Array.isArray(call.input.proposals) ? call.input.proposals.slice(0, MAX_PROPOSALS) : [];
  if (!proposals.length) return { ok: true, proposals: 0, noChanges: call.input.no_changes_reason ?? "no changes warranted" };

  const batchId = crypto.randomUUID();
  const themeByKey = new Map(ev.themes.map((t) => [t.key, t]));
  const rows = proposals
    .filter((p: any) => p && typeof p === "object" && p.kind)
    .map((p: any) => ({
      batch_id: batchId,
      kind: p.kind,
      target_key: p.target_key ?? null,
      current: p.kind.startsWith("theme") && p.target_key ? themeByKey.get(p.target_key) ?? null : null,
      proposed: p.proposed ?? {},
      rationale: String(p.rationale ?? "").slice(0, 1000),
      evidence: String(p.evidence ?? "").slice(0, 1000),
    }));
  await db.from("draft_proposals").insert(rows);
  return { ok: true, proposals: rows.length };
}

const THEME_FIELD_WHITELIST = ["name", "intent", "prompt_direction", "channels", "sort_order", "enabled"] as const;

export async function decideDraftProposal(
  db: SupabaseClient,
  id: string,
  approve: boolean,
  decidedBy: string
): Promise<{ ok: boolean; reason?: string }> {
  const { data: p } = await db.from("draft_proposals").select("*").eq("id", id).eq("status", "pending").maybeSingle();
  if (!p) return { ok: false, reason: "proposal not found or already decided" };

  if (approve) {
    const proposed = (p.proposed ?? {}) as Record<string, unknown>;
    if (p.kind === "theme_edit" || p.kind === "theme_add") {
      const patch: Record<string, unknown> = {};
      for (const f of THEME_FIELD_WHITELIST) if (proposed[f] !== undefined) patch[f] = proposed[f];
      if (p.kind === "theme_edit") {
        if (!p.target_key) return { ok: false, reason: "theme_edit missing target_key" };
        const { error } = await db.from("comm_themes").update(patch).eq("key", p.target_key);
        if (error) return { ok: false, reason: error.message };
      } else {
        const key = String(p.target_key ?? "").trim();
        if (!/^[a-z0-9_]{2,40}$/.test(key)) return { ok: false, reason: "theme_add needs a snake_case target_key" };
        if (!patch.name || !patch.prompt_direction) return { ok: false, reason: "theme_add needs name + prompt_direction" };
        const { error } = await db.from("comm_themes").upsert({ key, enabled: true, ...patch }, { onConflict: "key" });
        if (error) return { ok: false, reason: error.message };
      }
    } else if (p.kind === "theme_retire") {
      if (!p.target_key) return { ok: false, reason: "theme_retire missing target_key" };
      const { error } = await db.from("comm_themes").update({ enabled: false }).eq("key", p.target_key);
      if (error) return { ok: false, reason: error.message };
    } else if (p.kind === "style_add") {
      const { count } = await db.from("draft_style_rules").select("id", { count: "exact", head: true }).eq("enabled", true);
      if ((count ?? 0) >= MAX_ACTIVE_STYLE_RULES) return { ok: false, reason: `style rules at cap (${MAX_ACTIVE_STYLE_RULES}) — retire one first` };
      const rule = String(proposed.rule ?? "").trim();
      if (!rule) return { ok: false, reason: "style_add missing rule text" };
      const channel = ["all", "email", "sms", "call"].includes(String(proposed.channel)) ? String(proposed.channel) : "all";
      const { error } = await db.from("draft_style_rules").insert({ channel, rule: rule.slice(0, 300), source: "critic" });
      if (error) return { ok: false, reason: error.message };
    } else if (p.kind === "style_retire") {
      if (!p.target_key) return { ok: false, reason: "style_retire missing target_key (rule id)" };
      const { error } = await db.from("draft_style_rules").update({ enabled: false }).eq("id", p.target_key);
      if (error) return { ok: false, reason: error.message };
    } else {
      return { ok: false, reason: `unknown kind ${p.kind}` };
    }
  }

  await db
    .from("draft_proposals")
    .update({ status: approve ? "approved" : "rejected", decided_by: decidedBy, decided_at: new Date().toISOString() })
    .eq("id", id);
  return { ok: true };
}
