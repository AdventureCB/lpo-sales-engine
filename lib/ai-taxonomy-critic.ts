import "server-only";
import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaudeTool, logAiUsage } from "./ai";
import { loadAiConfig, monthToDateSpendCents } from "./ai-profiler";

/**
 * Taxonomy critic: reads accumulated evidence (corrections, outcomes, tag
 * frequencies, fit failures) against the current archetype/attribute mapping
 * and PROPOSES changes. Nothing self-applies — proposals wait in
 * taxonomy_proposals for human approval. Evidence thresholds keep increments
 * meaningful: most runs should conclude "no changes warranted".
 */

const PROPOSALS_TOOL = {
  name: "record_taxonomy_proposals",
  description: "Record taxonomy change proposals (or none).",
  input_schema: {
    type: "object",
    properties: {
      proposals: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["archetype_edit", "archetype_add", "archetype_retire", "attribute_edit", "attribute_add", "attribute_retire"],
            },
            target_key: { type: "string", description: "Existing key for edit/retire; omit for add." },
            proposed: {
              type: "object",
              description:
                "ONLY the fields to set. Archetypes: key,name,emoji,tagline,description,positive_traits[],negative_traits[],signals[],ad_ids[],selling_approach,avoid. Attributes: key,name,description,category,value_type(single_select|multi_select|scale|boolean|text),options[],importance(0-3).",
            },
            rationale: { type: "string", description: "Why — cite the evidence counts driving this." },
            evidence: { type: "string", description: "The specific numbers/examples (terse)." },
          },
          required: ["kind", "proposed", "rationale"],
        },
      },
      no_changes_reason: { type: "string", description: "When proposing nothing: why the evidence doesn't clear the bar yet." },
    },
    required: ["proposals"],
  },
};

async function gatherEvidence(db: SupabaseClient, bootstrap: boolean): Promise<string> {
  const [{ data: profiles }, { data: closed }] = await Promise.all([
    db.from("deal_profiles").select("archetypes, tags, corrections, overall_confidence, next_action, summary").limit(1000),
    db
      .from("crm_deals")
      .select("status, lost_reason, value_cents, deal_profiles ( archetypes, summary )")
      .in("status", ["won", "lost"])
      .or(`won_at.gte.${new Date(Date.now() - 120 * 86_400_000).toISOString()},lost_at.gte.${new Date(Date.now() - 120 * 86_400_000).toISOString()}`)
      .limit(500),
  ]);

  // Corrections aggregate.
  const wrongArch: Record<string, number> = {};
  const clearedAttr: Record<string, number> = {};
  const notes: string[] = [];
  for (const p of profiles ?? []) {
    const c = (p.corrections as any) ?? {};
    for (const k of c.archetypes_wrong ?? []) wrongArch[k] = (wrongArch[k] ?? 0) + 1;
    for (const k of c.attributes_cleared ?? []) clearedAttr[k] = (clearedAttr[k] ?? 0) + 1;
    for (const n of c.notes ?? []) notes.push(String(n.text).slice(0, 160));
  }

  // Tag frequency.
  const tagCount: Record<string, number> = {};
  for (const p of profiles ?? []) for (const t of (p.tags as string[]) ?? []) tagCount[t] = (tagCount[t] ?? 0) + 1;
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 40);

  // Archetype usage + fit failures.
  const archUse: Record<string, { n: number; avgPct: number }> = {};
  let fitFailures = 0;
  const fitFailureSummaries: string[] = [];
  for (const p of profiles ?? []) {
    const arr = (p.archetypes as any[]) ?? [];
    for (const a of arr) {
      const e = (archUse[a.key] = archUse[a.key] ?? { n: 0, avgPct: 0 });
      e.avgPct = (e.avgPct * e.n + (a.pct ?? 0)) / (e.n + 1);
      e.n++;
    }
    const top = arr.slice().sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0];
    const band = (p.next_action as any)?.data_sufficiency?.band;
    if ((band === "Solid" || band === "Rich") && (!top || (top.pct ?? 0) < 40)) {
      fitFailures++;
      if (p.summary && fitFailureSummaries.length < 8) fitFailureSummaries.push(String(p.summary).slice(0, 200));
    }
  }

  // Outcomes by dominant archetype.
  const outcome: Record<string, { closed: number; won: number; reasons: Record<string, number> }> = {};
  const wonSummaries: string[] = [];
  const lostSummaries: string[] = [];
  for (const d of (closed ?? []) as any[]) {
    const prof = Array.isArray(d.deal_profiles) ? d.deal_profiles[0] : d.deal_profiles;
    const top = ((prof?.archetypes as any[]) ?? []).slice().sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0];
    if (top?.key) {
      const e = (outcome[top.key] = outcome[top.key] ?? { closed: 0, won: 0, reasons: {} });
      e.closed++;
      if (d.status === "won") e.won++;
      else if (d.lost_reason) e.reasons[d.lost_reason] = (e.reasons[d.lost_reason] ?? 0) + 1;
    }
    if (bootstrap && prof?.summary) {
      const bucket = d.status === "won" ? wonSummaries : lostSummaries;
      if (bucket.length < 10) bucket.push(String(prof.summary).slice(0, 220));
    }
  }

  return [
    `Profiles in evidence: ${(profiles ?? []).length}. Closed profiled deals (120d): ${Object.values(outcome).reduce((a, e) => a + e.closed, 0)}.`,
    `\n## Rep corrections (archetype marked WRONG, by key)\n${Object.entries(wrongArch).map(([k, n]) => `${k}: ${n}`).join(", ") || "none"}`,
    `\n## Rep corrections (attribute CLEARED, by key)\n${Object.entries(clearedAttr).map(([k, n]) => `${k}: ${n}`).join(", ") || "none"}`,
    notes.length ? `\n## Rep free-text corrections (sample)\n${notes.slice(-30).map((n) => `- ${n}`).join("\n")}` : "",
    `\n## Tag frequencies (candidate attributes/archetypes when recurring)\n${topTags.map(([t, n]) => `${t}×${n}`).join(", ") || "none"}`,
    `\n## Archetype usage (appearances across profiles, avg fit %)\n${Object.entries(archUse).map(([k, e]) => `${k}: n=${e.n} avg=${Math.round(e.avgPct)}%`).join("; ") || "none"}`,
    `\n## Fit failures (Solid/Rich data but no archetype ≥40%): ${fitFailures}${fitFailureSummaries.length ? `\nSamples:\n${fitFailureSummaries.map((s) => `- ${s}`).join("\n")}` : ""}`,
    `\n## Outcomes by dominant archetype\n${Object.entries(outcome).map(([k, e]) => `${k}: ${e.won}/${e.closed} won${Object.keys(e.reasons).length ? `, lost: ${Object.entries(e.reasons).map(([r, n]) => `${r}×${n}`).join(", ")}` : ""}`).join("\n") || "none"}`,
    bootstrap && wonSummaries.length ? `\n## WON deal profile summaries (bootstrap sample)\n${wonSummaries.map((s) => `- ${s}`).join("\n")}` : "",
    bootstrap && lostSummaries.length ? `\n## LOST deal profile summaries (bootstrap sample)\n${lostSummaries.map((s) => `- ${s}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

export async function runTaxonomyReview(
  db: SupabaseClient,
  opts: { bootstrap?: boolean } = {}
): Promise<{ ok: boolean; reason?: string; batchId?: string; count?: number; noChangesReason?: string }> {
  const cfg = await loadAiConfig(db);
  if ((await monthToDateSpendCents(db)) >= cfg.monthly_budget_cents) return { ok: false, reason: "monthly AI budget reached" };

  const [{ data: archs }, { data: attrs }] = await Promise.all([
    db.from("deal_archetypes").select("*").order("sort_order"),
    db.from("profile_attributes").select("*").order("sort_order"),
  ]);
  const evidence = await gatherEvidence(db, opts.bootstrap === true);

  const call = await callClaudeTool({
    tier: cfg.models.critic ?? "sonnet",
    systemCached: [
      `You are the taxonomy critic for Lone Peak Overland's AI deal-profiler. LPO sells made-to-order pop-up truck-bed campers. The taxonomy (buyer archetypes + universal attributes) drives every buyer profile, call script, and draft — changes ripple widely, so propose MEANINGFUL INCREMENTS ONLY.`,
      `THRESHOLDS — do not propose a change unless evidence clears a bar:`,
      `- Edit an archetype's traits/anti-signals/approach: ≥5 rep corrections against it OR a clear outcome pattern (≥10 closed with a skewed lost reason).`,
      `- Add an attribute: a tag recurring on ≥10 profiles that reps would act on.`,
      `- Add an archetype: ≥8 fit-failures whose summaries describe the same missing persona.`,
      `- Retire/merge: an archetype with high correction rate AND low usage, or an attribute cleared repeatedly and rarely filled.`,
      `${opts.bootstrap ? "BOOTSTRAP MODE: this is the first deep pass — you may additionally propose enrichments to EVERY archetype (fuller positive/negative traits, watch-for signals, sharper selling approaches grounded in the won/lost summaries) even below thresholds, but keep each proposal defensible from the evidence shown." : "Standard review: most runs should return ZERO proposals with a no_changes_reason."}`,
      `Keys are stable snake_case identifiers — never rename an existing key (edit fields instead). Max 12 proposals, highest-impact first. Every proposal cites its evidence.`,
    ].join("\n\n"),
    user: [
      `# CURRENT ARCHETYPES\n${JSON.stringify(archs ?? [], null, 0).slice(0, 12000)}`,
      `\n# CURRENT ATTRIBUTES\n${JSON.stringify(attrs ?? [], null, 0).slice(0, 6000)}`,
      `\n# EVIDENCE SINCE LAST REVIEW\n${evidence.slice(0, 14000)}`,
    ].join("\n"),
    tool: PROPOSALS_TOOL,
    maxTokens: 4000,
  });
  await logAiUsage(db, { dealId: null, task: opts.bootstrap ? "taxonomy_bootstrap" : "taxonomy_review", tier: cfg.models.critic ?? "sonnet", call });

  const proposals: any[] = call.input.proposals ?? [];
  if (proposals.length === 0) return { ok: true, count: 0, noChangesReason: call.input.no_changes_reason ?? "No changes warranted yet." };

  const batchId = crypto.randomUUID();
  const archByKey = new Map((archs ?? []).map((a: any) => [a.key, a]));
  const attrByKey = new Map((attrs ?? []).map((a: any) => [a.key, a]));
  const rows = proposals.slice(0, 12).map((p) => ({
    batch_id: batchId,
    kind: p.kind,
    target_key: p.target_key ?? p.proposed?.key ?? null,
    current: p.kind.startsWith("archetype") ? archByKey.get(p.target_key) ?? null : attrByKey.get(p.target_key) ?? null,
    proposed: p.proposed ?? {},
    rationale: String(p.rationale ?? "").slice(0, 1000),
    evidence: p.evidence ? String(p.evidence).slice(0, 1000) : null,
  }));
  const { error } = await db.from("taxonomy_proposals").insert(rows);
  if (error) return { ok: false, reason: `save failed: ${error.message}` };
  return { ok: true, batchId, count: rows.length };
}

/** Apply an approval: write the change to the live taxonomy + ripple stale. */
export async function decideProposal(
  db: SupabaseClient,
  id: string,
  approve: boolean,
  actor: string
): Promise<{ ok: boolean; reason?: string }> {
  const { data: p } = await db.from("taxonomy_proposals").select("*").eq("id", id).maybeSingle();
  if (!p) return { ok: false, reason: "proposal not found" };
  if (p.status !== "pending") return { ok: false, reason: "already decided" };

  if (approve) {
    const table = p.kind.startsWith("archetype") ? "deal_archetypes" : "profile_attributes";
    const proposed = (p.proposed as Record<string, unknown>) ?? {};
    if (p.kind.endsWith("_retire")) {
      if (!p.target_key) return { ok: false, reason: "retire needs target_key" };
      const { error } = await db.from(table).update({ enabled: false, updated_at: new Date().toISOString() }).eq("key", p.target_key);
      if (error) return { ok: false, reason: error.message };
    } else if (p.kind.endsWith("_add")) {
      const { error } = await db.from(table).insert({ ...proposed, enabled: true });
      if (error) return { ok: false, reason: error.message };
    } else {
      if (!p.target_key) return { ok: false, reason: "edit needs target_key" };
      const { key: _drop, ...fields } = proposed as any;
      const { error } = await db.from(table).update({ ...fields, updated_at: new Date().toISOString() }).eq("key", p.target_key);
      if (error) return { ok: false, reason: error.message };
    }
    // Ripple: bust open-deal profile hashes so the background refresh folds
    // the new taxonomy in gradually (budget + debounce still govern pace).
    await db.rpc("bust_open_profile_hashes").then(
      () => {},
      () => {} // rpc may not exist yet in older envs — non-fatal
    );
  }

  const { error } = await db
    .from("taxonomy_proposals")
    .update({ status: approve ? "approved" : "rejected", decided_by: actor, decided_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}
