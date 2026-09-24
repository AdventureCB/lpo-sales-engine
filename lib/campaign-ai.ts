import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaudeTool, logAiUsage } from "./ai";
import { loadAiConfig } from "./ai-profiler";
import { buildCommContext, budgetOk, COMPANY, loadDealContext } from "./ai-scripts";
import { steeringForDeal } from "./ai-hypotheses";
import { bookingBase, repBookingUrl } from "./booking";

/**
 * Links that belong to THIS buyer / THIS rep (Kyle 9/24): the buyer's own
 * saved 3D build (never the generic builder page) and the deal owner's own
 * booking page (never another rep's Calendly from the asset library).
 */
export async function buyerLinks(db: SupabaseClient, dealId: string, ownerEmail: string): Promise<{ savedBuilds: string[]; bookingUrl: string; truck: string | null; ownerFirst: string }> {
  const { data: deal } = await db.from("crm_deals").select("truck_model, crm_contacts ( emails )").eq("id", dealId).maybeSingle();
  const emails = (((deal as any)?.crm_contacts?.emails as any[]) ?? []).map((e) => String(e.value ?? "").toLowerCase()).filter(Boolean);
  const urls: { url: string; at: string }[] = [];
  const BUILD = /https:\/\/www\.lonepeakoverland\.com\/products\/[^\s)"'<]+\?[^\s)"'<]*car=[^\s)"'<]+/g;
  const grab = (text: string | null | undefined, at: string) => { for (const m of String(text ?? "").match(BUILD) ?? []) urls.push({ url: m, at }); };
  const [{ data: kev }, { data: iev }, { data: notes }, { data: rep }] = await Promise.all([
    emails.length ? db.from("klaviyo_events").select("detail, event_at").in("email", emails).ilike("metric", "%save build%").order("event_at", { ascending: false }).limit(5) : Promise.resolve({ data: [] as any[] }),
    db.from("intake_events").select("detail, created_at").eq("deal_id", dealId).order("created_at", { ascending: false }).limit(5),
    db.from("crm_activities").select("body, occurred_at").eq("deal_id", dealId).ilike("body", "%car=%").order("occurred_at", { ascending: false }).limit(5),
    db.from("reps").select("name, booking_slug, booking_enabled").eq("email", ownerEmail).maybeSingle(),
  ]);
  for (const e of (kev ?? []) as any[]) grab(e.detail?.configuration_url, e.event_at);
  for (const e of (iev ?? []) as any[]) grab(e.detail?.link, e.created_at);
  for (const n of (notes ?? []) as any[]) grab(n.body, n.occurred_at);
  const seen = new Set<string>();
  const savedBuilds = urls.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).filter((u) => (seen.has(u.url) ? false : (seen.add(u.url), true))).map((u) => u.url).slice(0, 2);
  const bookingUrl = rep?.booking_enabled && rep.booking_slug ? repBookingUrl(rep.booking_slug) : bookingBase();
  return { savedBuilds, bookingUrl, truck: (deal as any)?.truck_model ?? null, ownerFirst: (rep?.name ?? ownerEmail).split(/[\s@]/)[0] };
}

const BOOKING_HOST = /https?:\/\/(?:[a-z0-9-]+\.)?calendly\.com\/[^\s)]*|https?:\/\/book\.lonepeakoverland\.com\/[^\s)]*|https?:\/\/lpo-sales-engine\.vercel\.app\/book\/[^\s)]*/gi;
const GENERIC_BUILDER = /https:\/\/www\.lonepeakoverland\.com\/(products\/lone-peak-camper(?:-v2)?\/?|pages\/(?:3d-)?build(?:er)?\/?)(?![^\s)]*car=)/i;

/** Force every scheduling link to the owner's own booking page, keeping the label. */
export function normalizeLinks(body: string, bookingUrl: string): string {
  let out = body.replace(BOOKING_HOST, (u) => (u.toLowerCase().startsWith(bookingUrl.toLowerCase()) ? u : bookingUrl));
  // Bare URLs (outside markdown links) become clickable text.
  out = out.replace(/(^|[^(\]])(https?:\/\/[^\s)>\]]+)/g, (m, pre, url) => {
    if (/\]\($/.test(pre)) return m;
    const label = /car=/.test(url) ? "your saved build" : url.toLowerCase().startsWith(bookingUrl.toLowerCase()) ? "grab a time here" : "this link";
    return `${pre}[${label}](${url})`;
  });
  return out;
}

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
  "Every link must be written as markdown [a few descriptive words](url), never a bare URL. Only two kinds of links exist for you: the buyer-specific links listed under BUYER-SPECIFIC LINKS (their own saved build, the rep's own booking page) and the asset library. Never use any calendar link from the asset library; the rep's booking page is the only way to offer a time.",
  "If the instruction mentions the buyer's build, link THEIR saved build URL exactly as given, never the generic builder page. If it mentions their truck, name the exact truck model from the deal facts.",
];

const BANNED = /(hope this (email |message )?finds you|checking in|circling back|touch(ing)? base|wanted to reach out|don'?t hesitate|feel free|game.?changer|\bunlock\b|\belevate\b|seamless|as a reminder|\bjourney\b)/i;

/** Style problems the model must fix; empty = clean. */
export function styleViolations(subject: string, body: string, links?: { savedBuilds: string[]; bookingUrl: string }): string[] {
  const out: string[] = [];
  if (/(^|[^(\]])https?:\/\/[^\s)]+/.test(body.replace(/\]\((https?:\/\/[^\s)]+)\)/g, ""))) out.push("contains a bare URL (links must be [descriptive text](url))");
  if (links) {
    const foreign = (body.match(BOOKING_HOST) ?? []).filter((u) => !u.toLowerCase().startsWith(links.bookingUrl.toLowerCase()));
    if (foreign.length) out.push("links to a calendar that is not this rep's booking page");
    if (links.savedBuilds.length && GENERIC_BUILDER.test(body)) out.push("links the generic builder page instead of the buyer's saved build");
  }
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
    ownerEmail: string;
    priorSends: PriorSend[];
  }
): Promise<{ subject: string; body: string; rationale: string; model: string; warnings: string[] }> {
  const cfg = await loadAiConfig(db);
  const ctx = await loadDealContext(db, args.dealId);
  if (!ctx) throw new Error("deal not found");
  if (!(await budgetOk(db, cfg.monthly_budget_cents))) throw new Error("monthly AI budget reached");
  const tier = cfg.models.drafts ?? "sonnet";
  const [commContext, { data: rules }, steer, links] = await Promise.all([
    buildCommContext(db),
    db.from("draft_style_rules").select("rule").eq("enabled", true).in("channel", ["all", "email"]).order("created_at", { ascending: false }).limit(10),
    steeringForDeal(db, args.dealId).catch(() => ({ patterns: [] as string[], themeBoosts: {} })),
    buyerLinks(db, args.dealId, args.ownerEmail),
  ]);
  const linkText = [
    links.savedBuilds.length
      ? `Their saved build${links.savedBuilds.length > 1 ? "s (newest first)" : ""}: ${links.savedBuilds.map((u) => `[your saved build](${u})`).join(" · ")}`
      : "They have no saved build on file (do not link the builder at all).",
    `${links.ownerFirst}'s booking page (the ONLY scheduling link allowed): [grab a time](${links.bookingUrl})`,
  ].join("\n");

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
    `\n# BUYER-SPECIFIC LINKS\n${linkText}`,
    `\n# BUYER PROFILE\n${ctx.profileText}`,
    `\n# DEAL\n${ctx.inputs.header}${links.truck ? `\nTruck: ${links.truck}` : "\nTruck: not on file (do not guess)"}`,
    `\n# SIGNALS\n${ctx.inputs.signalText}`,
    `\n# CALL HISTORY\n${ctx.inputs.callText}`,
    ctx.inputs.notes.length ? `\n# RECENT NOTES\n${ctx.inputs.notes.slice(-6).join("\n")}` : "",
  ].filter(Boolean).join("\n");

  let call = await callClaudeTool({ tier, systemCached, user, tool: CAMPAIGN_TOOL, maxTokens: 900 });
  await logAiUsage(db, { dealId: args.dealId, task: "campaign_email", tier, call });
  let subject = String(call.input?.subject ?? "").trim();
  let body = String(call.input?.body ?? "").trim();
  let rationale = String(call.input?.rationale ?? "").trim();
  let warnings = styleViolations(subject, body, links);
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
    const w2 = styleViolations(s2, b2, links);
    if (b2 && w2.length <= warnings.length) { subject = s2; body = b2; rationale = String(fix.input?.rationale ?? rationale).trim(); warnings = w2; call = fix; }
  }
  if (!subject || !body) throw new Error("model returned an empty draft");
  // Hard guarantees regardless of what the model did: scheduling links are the
  // owner's, and every URL is clickable text.
  body = normalizeLinks(body, links.bookingUrl);
  warnings = styleViolations(subject, body, links);
  return { subject, body, rationale, model: tier, warnings };
}
