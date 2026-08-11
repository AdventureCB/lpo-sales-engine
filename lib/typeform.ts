import type { SupabaseClient } from "@supabase/supabase-js";
import { mergeContactAttribution, linkVisitor } from "./attribution";

/**
 * Contact + Q/A extraction from a form_response. Tolerant of every shape
 * Typeform emits: scalar email/phone_number answers, the composite
 * contact_info block (what the 8/8 opt-in edit switched the forms to),
 * and an email passed via hidden params as a last resort.
 */
export function extractTypeformContact(fr: any): {
  email: string | null;
  phone: string | null;
  name: string | null;
  qa: string[];
  smsConsent: boolean | null;
} {
  const titleById = new Map<string, string>(
    ((fr?.definition?.fields ?? []) as any[]).map((f) => [f.id, f.title ?? f.ref ?? ""])
  );
  let email: string | null = null;
  let phone: string | null = null;
  let first = "";
  let last = "";
  let smsConsent: boolean | null = null;
  let loneBoolean: boolean | null = null;
  let booleanCount = 0;
  const qa: string[] = [];

  for (const a of (fr?.answers ?? []) as any[]) {
    const title = titleById.get(a.field?.id) ?? a.field?.ref ?? "";
    if (typeof a.boolean === "boolean") {
      booleanCount++;
      loneBoolean = a.boolean;
      // The surveys' SMS opt-in yes/no ("Do you agree to receive text messages…").
      if (/text|sms|messag/i.test(title)) smsConsent = a.boolean;
    }
    const ci = a.contact_info ?? null;
    const em = a.email ?? ci?.email ?? null;
    const ph = a.phone_number ?? ci?.phone_number ?? null;
    if (em && !email) email = String(em).toLowerCase().trim();
    if (ph && !phone) phone = String(ph);
    if (ci?.first_name && !first) first = ci.first_name;
    if (ci?.last_name && !last) last = ci.last_name;

    const v =
      a.text ??
      em ??
      ph ??
      a.number?.toString() ??
      a.choice?.label ??
      (Array.isArray(a.choices?.labels) ? a.choices.labels.join(", ") : null) ??
      a.date ??
      a.boolean?.toString() ??
      (ci ? [ci.first_name, ci.last_name, ci.email, ci.phone_number].filter(Boolean).join(" ") : null) ??
      "";
    if (!v) continue;
    if (!ci && /first/i.test(title) && !first) first = v;
    else if (!ci && /last/i.test(title) && !last) last = v;
    if (a.type !== "email") qa.push(`${title || a.type}: ${v}`);
  }

  if (!email) {
    const h = fr?.hidden?.email;
    if (typeof h === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(h.trim())) email = h.trim().toLowerCase();
  }
  // Title lookup can miss on webhook payloads (group children) — when the
  // form has exactly one yes/no, that IS the opt-in question.
  if (smsConsent == null && booleanCount === 1) smsConsent = loneBoolean;
  return { email, phone, name: [first, last].filter(Boolean).join(" ") || null, qa, smsConsent };
}

/**
 * Record an SMS consent statement on the matching contact (latest form
 * answer wins), with provenance for 10DLC. Never overwrites a real STOP.
 */
export async function recordSmsConsent(
  db: SupabaseClient,
  args: { email: string | null; phone: string | null; consent: boolean; at: string | null; source: string | null }
): Promise<void> {
  let contact: { id: string; sms_consent: string | null } | null = null;
  if (args.email) {
    const { data } = await db
      .from("crm_contacts")
      .select("id, sms_consent")
      .filter("emails", "cs", JSON.stringify([{ value: args.email }]))
      .limit(1)
      .maybeSingle();
    contact = data;
  }
  if (!contact && args.phone) {
    const digits = args.phone.replace(/\D/g, "");
    const e164 = digits.length === 10 ? `+1${digits}` : digits.length >= 8 ? `+${digits}` : null;
    if (e164) {
      const { data } = await db
        .from("crm_contacts")
        .select("id, sms_consent")
        .filter("phones", "cs", JSON.stringify([{ e164 }]))
        .limit(1)
        .maybeSingle();
      contact = data;
    }
  }
  if (!contact || contact.sms_consent === "opted_out") return;
  await db
    .from("crm_contacts")
    .update({
      sms_consent: args.consent ? "opted_in" : "declined",
      sms_consent_at: args.at ?? new Date().toISOString(),
      sms_consent_source: args.source,
      updated_at: new Date().toISOString(),
    })
    .eq("id", contact.id);
}

/**
 * One submission, end to end: store raw, land ad attribution on the
 * contact, and route through the Intake Engine. Shared by the live
 * webhook and the Responses-API backfill; idempotent by response token.
 */
export async function ingestTypeformResponse(
  db: SupabaseClient,
  body: any
): Promise<{ matched: boolean; intakeAction: string | null }> {
  const fr = body?.form_response;
  if (!fr) return { matched: false, intakeAction: null };
  const formName = fr.definition?.title ?? null;
  const { email, phone, name, qa, smsConsent } = extractTypeformContact(fr);
  const eventId = String(fr.token ?? body.event_id ?? crypto.randomUUID()).slice(0, 100);

  const { data: row, error } = await db
    .from("typeform_submissions")
    .upsert(
      {
        event_id: eventId,
        form_id: fr.form_id ?? null,
        form_name: formName,
        email,
        submitted_at: fr.submitted_at ?? new Date().toISOString(),
        hidden: fr.hidden ?? {},
        raw: body,
      },
      { onConflict: "event_id" }
    )
    .select("id, email, hidden, submitted_at")
    .single();
  if (error || !row) throw new Error(`typeform store failed: ${error?.message}`);

  const matched = await matchSubmission(db, row as any);

  // Intake Engine routing — the engine matching this form creates/notes the
  // deal with answers as the note and hidden ad params attached.
  let intakeAction: string | null = null;
  const { data: engines } = await db
    .from("intake_sources")
    .select("id, channel_id, label, adapter, enabled, config")
    .eq("adapter", "typeform")
    .eq("enabled", true);
  const formLower = (formName ?? "").toLowerCase();
  const engine = (engines ?? []).find((s: any) => {
    const cfg = s.config ?? {};
    if (cfg.typeform_form_id) return cfg.typeform_form_id === fr.form_id;
    return cfg.typeform_form_name && formLower === String(cfg.typeform_form_name).toLowerCase();
  });
  if (engine && (email || phone)) {
    const cfg = (engine as any).config ?? {};
    if (!cfg.typeform_form_id && fr.form_id) {
      await db
        .from("intake_sources")
        .update({ config: { ...cfg, typeform_form_id: fr.form_id }, updated_at: new Date().toISOString() })
        .eq("id", (engine as any).id);
    }
    const { processIntake } = await import("./intake");
    const res = await processIntake(db, engine as any, {
      externalId: eventId,
      email,
      phone,
      name,
      note: qa.join("\n").slice(0, 1500) || null,
      occurredAt: fr.submitted_at ?? null,
      meta: { form_id: fr.form_id, form_name: formName, source_channel_id: (engine as any).channel_id, hidden: fr.hidden ?? {} },
    });
    intakeAction = res.action;
  }

  // Consent lands AFTER intake so a just-created contact is findable.
  if (smsConsent != null && (email || phone)) {
    await recordSmsConsent(db, {
      email,
      phone,
      consent: smsConsent,
      at: fr.submitted_at ?? null,
      source: formName,
    }).catch((e) => console.error("sms consent record failed", e));
  }
  return { matched, intakeAction };
}

/**
 * Fold a stored Typeform submission (hidden-field ad params + email) into
 * its CRM contact. Returns true when matched — or when there's nothing to
 * land (organic submission), which needs no retry.
 */
export async function matchSubmission(
  db: SupabaseClient,
  sub: { id: string; email: string | null; hidden: Record<string, unknown>; submitted_at: string | null }
): Promise<boolean> {
  if (!sub.email) return false;
  const h = sub.hidden ?? {};
  const S = (k: string) =>
    typeof h[k] === "string" && (h[k] as string).trim() ? (h[k] as string).trim().slice(0, 200) : undefined;
  const touch: Record<string, string | undefined> = {
    source: S("utm_source"),
    medium: S("utm_medium"),
    campaign: S("utm_campaign"),
    content: S("utm_content"),
    term: S("utm_term"),
    gclid: S("gclid"),
    fbclid: S("fbclid"),
    at: sub.submitted_at ?? new Date().toISOString(),
  };
  const clean = Object.fromEntries(Object.entries(touch).filter(([, v]) => v)) as any;
  const hasAd = clean.source || clean.gclid || clean.fbclid;

  let merged = false;
  if (hasAd) {
    merged = await mergeContactAttribution(db, sub.email, { first: clean, last: clean, touches: [clean] });
  }
  const vid = S("vid");
  if (vid) await linkVisitor(db, { attr_vid: vid }, sub.email);

  if (merged || !hasAd) {
    await db.from("typeform_submissions").update({ matched_at: new Date().toISOString() }).eq("id", sub.id);
    return true;
  }
  return false;
}
