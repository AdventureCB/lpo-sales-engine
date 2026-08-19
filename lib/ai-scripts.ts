import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaudeTool, logAiUsage } from "./ai";
import { loadAiConfig, monthToDateSpendCents } from "./ai-profiler";
import { gatherDealInputs } from "./ai-profiler-engine";

/**
 * Phase 3: per-deal scripts & drafts.
 * - Call script: lightweight StoryBrand outline, generated during the dialer's
 *   review-pause preload so it's ready before the rep advances. Cheap tier.
 * - Email / text drafts: generated individually on explicit rep request,
 *   quality tier, voiced from the macro/asset libraries.
 * All outputs cache on deal_profiles.scripts keyed by profile version — a
 * repeat preload of an unchanged deal costs nothing.
 */

// ── Comm-library context (voice + link understanding) ──────────────────────
// Compiled fresh from the DB each generation (cheap — it's just text), so new
// macros/assets flow in automatically. The expensive part — understanding
// what each URL asset's page actually is — runs once per asset and caches on
// comm_assets.link_summary (re-summarized only when the URL changes).

const SUMMARIZE_TOOL = {
  name: "record_link_summary",
  description: "Record what this web page is and offers.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "1-2 sentences: what the page is, what a sales rep would send it for." },
    },
    required: ["summary"],
  },
};

export async function summarizeAssetLinks(db: SupabaseClient): Promise<void> {
  const { data: assets } = await db
    .from("comm_assets")
    .select("id, name, url, kind, link_summary, link_summary_src")
    .eq("kind", "url");
  const pending = (assets ?? []).filter((a) => a.url && a.link_summary_src !== a.url).slice(0, 5); // budgeted per run
  for (const a of pending) {
    let pageText = "";
    try {
      const res = await fetch(a.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; lpo-sales-engine)" },
        signal: AbortSignal.timeout(6000),
      });
      const html = await res.text();
      pageText = html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 5000);
    } catch {
      /* unreachable page → summarize from the name alone */
    }
    try {
      const call = await callClaudeTool({
        tier: "haiku",
        systemCached: "You summarize Lone Peak Overland web pages for the sales team. Lone Peak sells made-to-order pop-up truck-bed campers and accessories.",
        user: `Asset name: "${a.name}"\nURL: ${a.url}\n\nPage text:\n${pageText || "(page not reachable — infer from the name/URL)"}`,
        tool: SUMMARIZE_TOOL,
        maxTokens: 300,
      });
      await logAiUsage(db, { dealId: null, task: "link_summary", tier: "haiku", call });
      await db
        .from("comm_assets")
        .update({ link_summary: call.input.summary ?? null, link_summary_src: a.url })
        .eq("id", a.id);
    } catch {
      /* leave unsummarized; retried next compile */
    }
  }
}

/** Compile the team-voice + asset context block. */
export async function buildCommContext(db: SupabaseClient): Promise<string> {
  await summarizeAssetLinks(db);
  const [{ data: macros }, { data: assets }] = await Promise.all([
    db.from("comm_macros").select("channel, name, subject, body, is_template").order("created_at").limit(60),
    db.from("comm_assets").select("name, url, kind, mime_type, link_summary").order("created_at").limit(40),
  ]);
  const byChannel = (ch: string[]) =>
    (macros ?? [])
      .filter((m) => ch.includes(m.channel))
      .slice(0, 10)
      .map((m) => `• ${m.name}${m.subject ? ` — subject: "${m.subject}"` : ""}\n  ${String(m.body ?? "").replace(/\s+/g, " ").slice(0, 400)}`)
      .join("\n");
  const assetLines = (assets ?? [])
    .map((a) =>
      a.kind === "url"
        ? `• [${a.name}](${a.url}) — ${a.link_summary ?? "no summary yet"}`
        : `• 📎 ${a.name} (${a.mime_type ?? "file"}) — email attachment`
    )
    .join("\n");
  return [
    `## Team voice — email macro exemplars (mimic tone/structure; NEVER copy verbatim)`,
    byChannel(["email", "any"]) || "(none yet)",
    ``,
    `## Team voice — text macro exemplars`,
    byChannel(["sms", "any"]) || "(none yet)",
    ``,
    `## Asset library (link these where they genuinely help — use markdown [name](url); each is described so you know what you're sending)`,
    assetLines || "(none yet)",
  ].join("\n");
}

// ── Shared bits ─────────────────────────────────────────────────────────────
const COMPANY =
  "You write for Lone Peak Overland (LPO), which sells the Lone Peak Camper — a made-to-order pop-up wedge truck-bed camper (from $7k, ~400 lb, 15-second setup) plus power/solar, heating, and gear accessories.";

async function loadDealContext(db: SupabaseClient, dealId: string) {
  const [inputs, { data: profile }] = await Promise.all([
    gatherDealInputs(db, dealId),
    db.from("deal_profiles").select("*").eq("deal_id", dealId).maybeSingle(),
  ]);
  if (!inputs) return null;
  const profileText = profile
    ? JSON.stringify(
        {
          summary: profile.summary,
          archetypes: (profile.archetypes ?? []).slice(0, 3),
          attributes: profile.attributes,
          tags: profile.tags,
          next_action: profile.next_action?.action,
          questions: profile.next_action?.questions_to_ask,
        },
        null,
        0
      ).slice(0, 3500)
    : "No profile yet — work from the raw deal info.";
  return { inputs, profile: profile ?? null, profileText };
}

async function budgetOk(db: SupabaseClient, capCents: number): Promise<boolean> {
  return (await monthToDateSpendCents(db)) < capCents;
}

/** Merge one script kind into deal_profiles.scripts (creates the row if the profiler hasn't run yet). */
async function saveScript(db: SupabaseClient, dealId: string, prior: any, kind: string, value: any, version: number) {
  const scripts = { ...((prior?.scripts as any) ?? {}), [kind]: value, [`${kind}_version`]: version, [`${kind}_at`]: new Date().toISOString() };
  if (prior) {
    await db.from("deal_profiles").update({ scripts, updated_at: new Date().toISOString() }).eq("deal_id", dealId);
  } else {
    await db.from("deal_profiles").upsert({ deal_id: dealId, scripts, status: "pending" }, { onConflict: "deal_id" });
  }
  return scripts;
}

// ── Call script (StoryBrand outline) ────────────────────────────────────────
const CALL_TOOL = {
  name: "record_call_script",
  description: "Record the call outline for this deal.",
  input_schema: {
    type: "object",
    properties: {
      hook: { type: "string", description: "One-line opener for THIS person — natural, not salesy." },
      their_story: { type: "string", description: "One line: the external problem they're solving + what it means to them (internal). The buyer is the hero." },
      guide_move: { type: "string", description: "One line: how the rep positions LPO as the guide — empathy + authority, tuned to the archetype mix." },
      plan: { type: "array", items: { type: "string" }, description: "2-4 short beats for the call — the simple plan to walk them through." },
      discovery: { type: "array", items: { type: "string" }, description: "2-3 natural discovery questions targeting the profile's biggest gaps." },
      objections: {
        type: "array",
        items: { type: "object", properties: { objection: { type: "string" }, counter: { type: "string" } }, required: ["objection", "counter"] },
        description: "1-3 likely objections for THIS buyer with one-line counters.",
      },
      cta: { type: "string", description: "The single clear ask to land before hanging up." },
      voicemail: { type: "string", description: "A ~15-second voicemail if they don't pick up." },
    },
    required: ["hook", "their_story", "guide_move", "plan", "discovery", "cta", "voicemail"],
  },
};

export async function generateCallScript(
  db: SupabaseClient,
  dealId: string,
  opts: { force?: boolean } = {}
): Promise<{ ok: boolean; reason?: string; script?: any; cached?: boolean }> {
  const cfg = await loadAiConfig(db);
  const ctx = await loadDealContext(db, dealId);
  if (!ctx) return { ok: false, reason: "deal not found" };
  const version = ctx.profile?.version ?? 0;
  const cached = (ctx.profile?.scripts as any)?.call;
  if (cached && (ctx.profile?.scripts as any)?.call_version === version && !opts.force) {
    return { ok: true, script: cached, cached: true };
  }
  if (!(await budgetOk(db, cfg.monthly_budget_cents))) return { ok: false, reason: "monthly AI budget reached" };

  const call = await callClaudeTool({
    tier: cfg.models.call_script ?? "haiku",
    systemCached: [
      COMPANY,
      `You produce a LIGHTWEIGHT call outline a rep can scan in 10 seconds mid-dial, built on StoryBrand principles: the BUYER is the hero on a quest; the rep is the GUIDE (empathy + authority); give them a simple PLAN and one clear call to action. Avoid failure-scare framing — keep it aspirational and concrete to this buyer's profile and interests.`,
      `Every line must be short. No paragraphs. No generic filler ("hope you're well"). Use the buyer's actual context (truck, interests, signals) wherever known.`,
    ].join("\n\n"),
    user: [`# BUYER PROFILE\n${ctx.profileText}`, `\n# DEAL\n${ctx.inputs.header}`, `\n# SIGNALS\n${ctx.inputs.signalText}`, `\n# CALL HISTORY\n${ctx.inputs.callText}`].join("\n"),
    tool: CALL_TOOL,
    maxTokens: 800,
  });
  await logAiUsage(db, { dealId, task: "call_script", tier: cfg.models.call_script ?? "haiku", call });
  await saveScript(db, dealId, ctx.profile, "call", call.input, version);
  return { ok: true, script: call.input };
}

// ── Email / text drafts ─────────────────────────────────────────────────────
const EMAIL_TOOL = {
  name: "record_email_draft",
  description: "Record the email draft.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string" },
      body: {
        type: "string",
        description: "Plain text with blank lines between short paragraphs. Links as markdown [label](url) using ONLY asset-library URLs. NO sign-off/signature — one is appended automatically.",
      },
    },
    required: ["subject", "body"],
  },
};
const SMS_TOOL = {
  name: "record_sms_draft",
  description: "Record the text-message draft.",
  input_schema: {
    type: "object",
    properties: {
      body: { type: "string", description: "One SMS in texting register, under ~320 characters. At most one link (asset-library URL, bare)." },
    },
    required: ["body"],
  },
};

export async function generateDraft(
  db: SupabaseClient,
  dealId: string,
  kind: "email" | "sms",
  repName: string | null,
  opts: { force?: boolean } = {}
): Promise<{ ok: boolean; reason?: string; draft?: any; cached?: boolean }> {
  const cfg = await loadAiConfig(db);
  const ctx = await loadDealContext(db, dealId);
  if (!ctx) return { ok: false, reason: "deal not found" };
  const version = ctx.profile?.version ?? 0;
  const cached = (ctx.profile?.scripts as any)?.[kind];
  if (cached && (ctx.profile?.scripts as any)?.[`${kind}_version`] === version && !opts.force) {
    return { ok: true, draft: cached, cached: true };
  }
  if (!(await budgetOk(db, cfg.monthly_budget_cents))) return { ok: false, reason: "monthly AI budget reached" };

  const commContext = await buildCommContext(db);
  const call = await callClaudeTool({
    tier: cfg.models.drafts ?? "sonnet",
    systemCached: [
      COMPANY,
      `You draft ${kind === "email" ? "a sales email" : "a text message"} for a specific buyer. Write in the TEAM'S VOICE — study the macro exemplars below for tone, length, and structure, then write something original tailored to THIS buyer's profile, interests, and where the conversation stands. StoryBrand posture: buyer is the hero, we're the guide; one clear call to action.`,
      commContext,
      `Rules: use the buyer's real first name; reference only true context (never invent conversations); link an asset ONLY when it genuinely helps this buyer next${kind === "email" ? "; NO sign-off — the rep's signature is appended automatically" : "; keep it under ~320 characters, texting register, no 'Dear'"}.`,
    ].join("\n\n"),
    user: [
      `Rep sending: ${repName ?? "the rep"}`,
      `\n# BUYER PROFILE\n${ctx.profileText}`,
      `\n# DEAL\n${ctx.inputs.header}`,
      `\n# SIGNALS\n${ctx.inputs.signalText}`,
      `\n# CALL HISTORY\n${ctx.inputs.callText}`,
      ctx.inputs.notes.length ? `\n# RECENT NOTES\n${ctx.inputs.notes.slice(-5).join("\n")}` : "",
    ].join("\n"),
    tool: kind === "email" ? EMAIL_TOOL : SMS_TOOL,
    maxTokens: 700,
  });
  await logAiUsage(db, { dealId, task: `draft_${kind}`, tier: cfg.models.drafts ?? "sonnet", call });
  await saveScript(db, dealId, ctx.profile, kind, call.input, version);
  return { ok: true, draft: call.input };
}
