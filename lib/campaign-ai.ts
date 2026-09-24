import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaudeTool, logAiUsage } from "./ai";
import { loadAiConfig } from "./ai-profiler";
import { buildCommContext, budgetOk, COMPANY, loadDealContext } from "./ai-scripts";
import { steeringForDeal } from "./ai-hypotheses";

/**
 * AI campaign step writer (Phase 2). Each step carries a rough prompt; the
 * model writes THIS buyer's email from everything we know about the deal,
 * as the rep, in a voice that must not read like a campaign or like AI
 * (Kyle 9/24). Hard style rules are enforced twice: in the instructions and
 * by a post-check that sends violations back for one rewrite.
 */

export const CAMPAIGN_STYLE_RULES = [
  "Write as the rep, in first person, to one specific person. It must read like a quick note a real person typed, never like marketing, a newsletter, or a template.",
  "Never use an em dash or en dash. Use at most ONE hyphen in the whole email, and only inside a compound word like 'pop-up'.",
  "Never use these phrases: 'I hope this finds you well', 'just checking in', 'circling back', 'touching base', 'I wanted to reach out', 'as a reminder', 'don't hesitate', 'feel free', 'exciting', 'game changer', 'unlock', 'elevate', 'seamless', 'journey', 'I understand'.",
  "No bullet points, numbered lists, headings, or bold. Two to five short paragraphs. Under 120 words unless the step prompt asks for more.",
  "Open with something specific to this buyer (their truck, the build they saved, something they said on a call). Never open with the rep's name, the company name, or a greeting longer than 'Hi <first name>,'.",
  "Only state facts that appear in the context below. Never invent conversations, prices, dates, availability, inventory, or details of their build.",
  "End with one natural next step phrased the way a person would actually ask it. No sales language, no urgency tricks.",
  "Subject line: short and specific, written the way a colleague would write it (sentence case, no title case, no clickbait, no emoji).",
  "No sign-off and no signature. The rep's signature is appended automatically.",
];

const BANNED = /(hope this (email |message )?finds you|checking in|circling back|touch(ing)? base|wanted to reach out|don'?t hesitate|feel free|game.?changer|\bunlock\b|\belevate\b|seamless|as a reminder|\bjourney\b)/i;

/** Style problems the model must fix; empty = clean. */
export function styleViolations(subject: string, body: string): string[] {
  const out: string[] = [];
  const all = `${subject}\n${body}`;
  if (/[—–]/.test(all)) out.push("contains an em dash or en dash");
  const hyphens = (all.match(/(?<=\w)-(?=\w)/g) ?? []).length;
  if (hyphens > 1) out.push(`uses ${hyphens} hyphens (max 1)`);
  const banned = all.match(BANNED);
  if (banned) out.push(`uses the banned phrase "${banned[0]}"`);
  if (/^\s*([-*•]|\d+\.)\s+/m.test(body)) out.push("contains a bullet or numbered list");
  if (/\*\*|^#{1,6}\s/m.test(body)) out.push("contains markdown bold or headings");
  const words = body.trim().split(/\s+/).length;
  if (words > 220) out.push(`${words} words (too long)`);
  if (/^(hi|hey|hello)\b[^\n]*\n\s*\n?\s*(my name is|this is \w+ (from|with)|i'?m \w+ (from|with))/i.test(body)) out.push("opens by introducing the rep or company");
  if (/[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+/.test(subject) && subject.split(" ").length >= 3 && subject === subject.replace(/\b(\w)/g, (c) => c.toUpperCase())) out.push("subject is in title case");
  return out;
}

const CAMPAIGN_TOOL = {
  name: "record_campaign_email",
  description: "Record the email for this buyer.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string" },
      body: { type: "string", description: "Plain text, blank lines between short paragraphs. Links only as markdown [label](url) with URLs taken from the asset library in the context. No sign-off." },
      rationale: { type: "string", description: "One sentence for the rep: what from this buyer's context you built the email around." },
    },
    required: ["subject", "body", "rationale"],
  },
};

export interface PriorSend { step: number; subject: string | null; body: string; sentAt: string | null; opened: boolean }

export async function generateCampaignEmail(
  db: SupabaseClient,
  args: {
    dealId: string;
    campaignName: string;
    stepPosition: number; // 0-based
    stepCount: number;
    prompt: string;
    steering: string | null;
    repName: string;
    priorSends: PriorSend[];
  }
): Promise<{ subject: string; body: string; rationale: string; model: string; warnings: string[] }> {
  const cfg = await loadAiConfig(db);
  const ctx = await loadDealContext(db, args.dealId);
  if (!ctx) throw new Error("deal not found");
  if (!(await budgetOk(db, cfg.monthly_budget_cents))) throw new Error("monthly AI budget reached");
  const tier = cfg.models.drafts ?? "sonnet";
  const [commContext, { data: rules }, steer] = await Promise.all([
    buildCommContext(db),
    db.from("draft_style_rules").select("rule").eq("enabled", true).in("channel", ["all", "email"]).order("created_at", { ascending: false }).limit(10),
    steeringForDeal(db, args.dealId).catch(() => ({ patterns: [] as string[], themeBoosts: {} })),
  ]);

  const systemCached = [
    COMPANY,
    `You write one follow-up email from a Lone Peak Overland sales rep to one specific buyer, as part of a short series the rep set up. The rep's rough instruction for this email is given below; you turn it into a hyper-specific note for THIS buyer using their profile, calls, notes and signals. StoryBrand posture: the buyer is the hero, the rep is the guide.`,
    `## Non-negotiable style rules\n${CAMPAIGN_STYLE_RULES.map((r) => `- ${r}`).join("\n")}`,
    (rules ?? []).length ? `## Standing style rules (learned from rep feedback — always apply)\n${(rules ?? []).map((r) => `- ${r.rule}`).join("\n")}` : "",
    commContext,
  ].filter(Boolean).join("\n\n");

  const priorText = args.priorSends.length
    ? args.priorSends.map((p) => `--- step ${p.step} (${p.sentAt ? `sent ${p.sentAt.slice(0, 10)}` : "not sent"}, ${p.opened ? "OPENED" : "not opened"}) ---\nSubject: ${p.subject ?? ""}\n${p.body}`).join("\n\n")
    : "(none yet — this is the first email in the series)";

  const user = [
    `Rep sending: ${args.repName}`,
    `Series: "${args.campaignName}", this is email ${args.stepPosition + 1} of ${args.stepCount}.`,
    `\n# THE REP'S INSTRUCTION FOR THIS EMAIL\n${args.prompt.trim()}`,
    args.steering?.trim() ? `\n# STEERING\n${args.steering.trim()}` : "",
    steer.patterns.length ? `\n# PROVEN PATTERNS (validated on real outcomes for deals like this — let them shape angle and emphasis)\n${steer.patterns.map((x: string) => `- ${x}`).join("\n")}` : "",
    `\n# EARLIER EMAILS IN THIS SERIES (do not repeat their points or phrasing; build on them; if the last one was not opened, change the angle)\n${priorText}`,
    `\n# BUYER PROFILE\n${ctx.profileText}`,
    `\n# DEAL\n${ctx.inputs.header}`,
    `\n# SIGNALS\n${ctx.inputs.signalText}`,
    `\n# CALL HISTORY\n${ctx.inputs.callText}`,
    ctx.inputs.notes.length ? `\n# RECENT NOTES\n${ctx.inputs.notes.slice(-6).join("\n")}` : "",
  ].filter(Boolean).join("\n");

  let call = await callClaudeTool({ tier, systemCached, user, tool: CAMPAIGN_TOOL, maxTokens: 900 });
  await logAiUsage(db, { dealId: args.dealId, task: "campaign_email", tier, call });
  let subject = String(call.input?.subject ?? "").trim();
  let body = String(call.input?.body ?? "").trim();
  let rationale = String(call.input?.rationale ?? "").trim();
  let warnings = styleViolations(subject, body);
  if (warnings.length) {
    // One rewrite pass with the exact problems named.
    const fix = await callClaudeTool({
      tier,
      systemCached,
      systemLive: `Your previous draft broke these rules: ${warnings.join("; ")}. Rewrite it so none of them apply. Keep the same substance.`,
      user: `${user}\n\n# YOUR PREVIOUS DRAFT\nSubject: ${subject}\n${body}`,
      tool: CAMPAIGN_TOOL,
      maxTokens: 900,
    });
    await logAiUsage(db, { dealId: args.dealId, task: "campaign_email_fix", tier, call: fix });
    const s2 = String(fix.input?.subject ?? "").trim();
    const b2 = String(fix.input?.body ?? "").trim();
    const w2 = styleViolations(s2, b2);
    if (b2 && w2.length <= warnings.length) { subject = s2; body = b2; rationale = String(fix.input?.rationale ?? rationale).trim(); warnings = w2; call = fix; }
  }
  if (!subject || !body) throw new Error("model returned an empty draft");
  return { subject, body, rationale, model: tier, warnings };
}
