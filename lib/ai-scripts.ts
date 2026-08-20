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

// The model occasionally returns a list field as a single string despite the
// schema — a malformed cached script crashed the dialer once. Normalize at
// write time so the cache only ever holds the declared shape.
const asArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)) : v == null || v === "" ? [] : String(v).split(/\n+/).map((s) => s.trim()).filter(Boolean);

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
      `FORMATTING (the card renders these): wrap the 1-2 LOAD-BEARING words of each line in **double asterisks** (bold — what the rep's eye should catch); wrap anything the CUSTOMER might say or think in *single asterisks* (italics — predicted responses, their words). Example: "Ask about the **bed length** — he'll likely say *I've got the 5-footer*". Never bold whole sentences.`,
    ].join("\n\n"),
    user: [`# BUYER PROFILE\n${ctx.profileText}`, `\n# DEAL\n${ctx.inputs.header}`, `\n# SIGNALS\n${ctx.inputs.signalText}`, `\n# CALL HISTORY\n${ctx.inputs.callText}`].join("\n"),
    tool: CALL_TOOL,
    maxTokens: 800,
  });
  await logAiUsage(db, { dealId, task: "call_script", tier: cfg.models.call_script ?? "haiku", call });
  const script = {
    ...call.input,
    plan: asArr(call.input.plan),
    discovery: asArr(call.input.discovery),
    objections: Array.isArray(call.input.objections) ? call.input.objections.filter((o: any) => o && typeof o === "object") : [],
  };
  await saveScript(db, dealId, ctx.profile, "call", script, version);
  return { ok: true, script };
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
  opts: { force?: boolean; theme?: string | null; direction?: string | null } = {}
): Promise<{ ok: boolean; reason?: string; draft?: any; cached?: boolean; draftId?: string }> {
  const cfg = await loadAiConfig(db);
  const ctx = await loadDealContext(db, dealId);
  if (!ctx) return { ok: false, reason: "deal not found" };
  const version = ctx.profile?.version ?? 0;

  // Theme + capped style rules (both admin-curated; see migration 00101).
  const themeKey = opts.theme?.trim() || null;
  const direction = opts.direction?.trim() || null;
  let theme: { key: string; name: string; prompt_direction: string } | null = null;
  if (themeKey) {
    const { data: t } = await db.from("comm_themes").select("key, name, prompt_direction").eq("key", themeKey).eq("enabled", true).maybeSingle();
    theme = t ?? null;
  }
  const { data: rules } = await db
    .from("draft_style_rules")
    .select("rule")
    .eq("enabled", true)
    .in("channel", ["all", kind])
    .order("created_at", { ascending: false })
    .limit(10);

  // Cache per theme (freeform direction always regenerates — it varies).
  const cacheKey = direction ? null : theme ? `${kind}~${theme.key}` : kind;
  const cached = cacheKey ? (ctx.profile?.scripts as any)?.[cacheKey] : null;
  if (cacheKey && cached && (ctx.profile?.scripts as any)?.[`${cacheKey}_version`] === version && !opts.force) {
    const draftId = await logDraftEvent(db, { dealId, kind, themeKey: theme?.key ?? null, direction: null, rep: repName, body: cached.body });
    return { ok: true, draft: cached, cached: true, draftId };
  }
  if (!(await budgetOk(db, cfg.monthly_budget_cents))) return { ok: false, reason: "monthly AI budget reached" };

  const commContext = await buildCommContext(db);
  const call = await callClaudeTool({
    tier: cfg.models.drafts ?? "sonnet",
    systemCached: [
      COMPANY,
      `You draft ${kind === "email" ? "a sales email" : "a text message"} for a specific buyer. Write in the TEAM'S VOICE — study the macro exemplars below for tone, length, and structure, then write something original tailored to THIS buyer's profile, interests, and where the conversation stands. StoryBrand posture: buyer is the hero, we're the guide; one clear call to action.`,
      commContext,
      (rules ?? []).length ? `## Standing style rules (learned from rep feedback — always apply)\n${(rules ?? []).map((r) => `- ${r.rule}`).join("\n")}` : "",
      `Rules: use the buyer's real first name; reference only true context (never invent conversations); link an asset ONLY when it genuinely helps this buyer next${kind === "email" ? "; NO sign-off — the rep's signature is appended automatically" : "; keep it under ~320 characters, texting register, no 'Dear'"}.`,
    ].filter(Boolean).join("\n\n"),
    user: [
      `Rep sending: ${repName ?? "the rep"}`,
      theme ? `\n# THEME (the rep chose this angle — follow it)\n${theme.name}: ${theme.prompt_direction}` : "",
      direction ? `\n# REP DIRECTION (specific ask for this draft — honor it exactly)\n${direction.slice(0, 400)}` : "",
      `\n# BUYER PROFILE\n${ctx.profileText}`,
      `\n# DEAL\n${ctx.inputs.header}`,
      `\n# SIGNALS\n${ctx.inputs.signalText}`,
      `\n# CALL HISTORY\n${ctx.inputs.callText}`,
      ctx.inputs.notes.length ? `\n# RECENT NOTES\n${ctx.inputs.notes.slice(-5).join("\n")}` : "",
    ].filter(Boolean).join("\n"),
    tool: kind === "email" ? EMAIL_TOOL : SMS_TOOL,
    maxTokens: 700,
  });
  await logAiUsage(db, { dealId, task: `draft_${kind}`, tier: cfg.models.drafts ?? "sonnet", call });
  if (cacheKey) await saveScript(db, dealId, ctx.profile, cacheKey, call.input, version);
  const draftId = await logDraftEvent(db, { dealId, kind, themeKey: theme?.key ?? null, direction, rep: repName, body: call.input.body });
  return { ok: true, draft: call.input, draftId };
}

/** One ledger row per generated draft — the feedback loop's raw material. */
async function logDraftEvent(
  db: SupabaseClient,
  e: { dealId: string; kind: string; themeKey: string | null; direction: string | null; rep: string | null; body: unknown }
): Promise<string | undefined> {
  try {
    const { data } = await db
      .from("draft_events")
      .insert({
        deal_id: e.dealId,
        kind: e.kind,
        theme_key: e.themeKey,
        direction: e.direction,
        rep: e.rep,
        draft_body: String(e.body ?? "").slice(0, 4000),
      })
      .select("id")
      .single();
    return data?.id;
  } catch {
    return undefined;
  }
}

/** Word-overlap similarity (0-1) between the draft and what was actually sent. */
export function draftSimilarity(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.max(wa.size, wb.size);
}

/**
 * Link a just-sent email/text back to the draft the rep used (45-min window)
 * and score how much it was edited. Best-effort — never fails the send.
 */
export async function linkDraftToSend(db: SupabaseClient, dealId: string, kind: "email" | "sms", sentActivityId: string | null, sentBody: string): Promise<void> {
  try {
    const since = new Date(Date.now() - 45 * 60_000).toISOString();
    const { data: ev } = await db
      .from("draft_events")
      .select("id, draft_body")
      .eq("deal_id", dealId)
      .eq("kind", kind)
      .is("sent_activity_id", null)
      .not("used_at", "is", null)
      .gte("generated_at", since)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!ev) return;
    await db
      .from("draft_events")
      .update({ sent_activity_id: sentActivityId, sent_similarity: draftSimilarity(ev.draft_body ?? "", sentBody) })
      .eq("id", ev.id);
  } catch {}
}

/**
 * Rank the theme catalog for THIS deal — zero-token heuristic on stage, deal
 * age, silence, source, and the profile's next_action. Keys stay stable so
 * feedback/stats attach; only the ordering is deal-aware.
 */
export async function suggestThemes(db: SupabaseClient, dealId: string) {
  const [{ data: themes }, { data: deal }, { data: profile }] = await Promise.all([
    db.from("comm_themes").select("key, name, intent, channels, sort_order").eq("enabled", true).order("sort_order"),
    db.from("crm_deals").select("id, title, created_at, last_activity_at, value_cents, deal_sources ( name )").eq("id", dealId).maybeSingle(),
    db.from("deal_profiles").select("next_action, tags, corrections").eq("deal_id", dealId).maybeSingle(),
  ]);
  if (!themes?.length) return [];
  const now = Date.now();
  const daysSilent = deal?.last_activity_at ? (now - new Date(deal.last_activity_at).getTime()) / 86_400_000 : 99;
  const ageDays = deal?.created_at ? (now - new Date(deal.created_at).getTime()) / 86_400_000 : 0;
  const hay = [
    deal?.title ?? "",
    (deal as any)?.deal_sources?.name ?? "",
    (profile?.next_action as any)?.action ?? "",
    ...((profile?.tags as string[]) ?? []),
  ].join(" ").toLowerCase();

  const score: Record<string, number> = {};
  for (const t of themes) score[t.key] = 0;
  const bump = (k: string, n: number) => {
    if (k in score) score[k] += n;
  };
  if (daysSilent >= 2 && daysSilent <= 14) bump("quick_nudge", 3);
  if (daysSilent < 2) bump("recap", 3);
  if (daysSilent > 21) bump("reengage", 3);
  if (daysSilent > 30 && ageDays > 60) bump("breakup", 4);
  if (/build|quote|config|cart/.test(hay)) bump("build_followup", 3);
  if (/financ|synchrony|payment|budget|price|afford/.test(hay)) bump("financing", 3);
  if (/call|schedule|phone|talk/.test(hay)) bump("schedule", 2);
  if (/object|concern|hesita|spouse|wife|husband|think about/.test(hay)) bump("objection", 3);
  if ((deal?.value_cents ?? 0) >= 700_000) bump("financing", 1);

  const ranked = [...themes].sort((a, b) => score[b.key] - score[a.key] || a.sort_order - b.sort_order);
  return ranked.map((t, i) => ({ key: t.key, name: t.name, intent: t.intent, channels: t.channels, suggested: i === 0 && score[t.key] > 0 }));
}
