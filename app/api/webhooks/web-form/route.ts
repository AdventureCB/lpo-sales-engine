import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { processIntake, normEmail, normPhone, type IntakeSource } from "@/lib/intake";
import { subscribeToList } from "@/lib/klaviyo";
import { SHOP_DOMAIN } from "@/lib/shopify-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Website forms → Intake Engine. The Shopify theme posts JSON here from the
 * browser; `form` picks the engine (intake_sources.adapter = "web_form",
 * config.form_key). The engine's pool / source / stage rules apply, the
 * message lands on the deal timeline, and the submitter is subscribed to the
 * engine's Klaviyo list when one is picked in Settings.
 *
 * Spam posture (the page is public, so there is no secret): browser Origin
 * must be one of ours, a hidden honeypot field must be empty, and one IP gets
 * 5 submissions per 10 minutes. Same email within 10 minutes = one deal.
 * Contract for the theme side: docs/website-form-intake.md.
 */

const ORIGIN_OK = [/(^|\.)lonepeakoverland\.com$/i, new RegExp(`^${SHOP_DOMAIN.replace(/\./g, "\\.")}$`, "i"), /\.shopifypreview\.com$/i];

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && originAllowed(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function originAllowed(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return ORIGIN_OK.some((re) => re.test(host));
  } catch {
    return false;
  }
}

const json = (body: unknown, status: number, origin: string | null) => NextResponse.json(body, { status, headers: corsHeaders(origin) });

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

const str = (v: unknown, max = 500): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  // Browsers always send Origin on cross-site POSTs; a missing header means a
  // server-side caller (our own curl tests), which is fine.
  if (origin && !originAllowed(origin)) return json({ ok: false, error: "origin not allowed" }, 403, origin);

  let body: Record<string, unknown>;
  try {
    const ct = req.headers.get("content-type") ?? "";
    body = ct.includes("application/json") ? await req.json() : Object.fromEntries((await req.formData()).entries());
  } catch {
    return json({ ok: false, error: "invalid body" }, 400, origin);
  }

  // Honeypot: the page renders a hidden input nobody fills in. Pretend success.
  if (str(body.website) || str(body.hp)) return json({ ok: true }, 200, origin);

  const formKey = str(body.form, 60);
  if (!formKey) return json({ ok: false, error: "form required" }, 400, origin);

  const email = normEmail(str(body.email, 200));
  const phone = normPhone(str(body.phone, 40));
  if (!email && !phone) return json({ ok: false, error: "email or phone required" }, 400, origin);

  const db = supabaseAdmin();
  const { data: source } = await db
    .from("intake_sources")
    .select("*")
    .eq("adapter", "web_form")
    .eq("enabled", true)
    .eq("config->>form_key", formKey)
    .maybeSingle();
  if (!source) return json({ ok: false, error: "unknown form" }, 404, origin);
  const src = source as IntakeSource;

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const { count } = await db
    .from("intake_events")
    .select("id", { count: "exact", head: true })
    .eq("source_id", src.id)
    .eq("detail->>ip", ip)
    .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
  if ((count ?? 0) >= 5) return json({ ok: false, error: "too many submissions, try again later" }, 429, origin);

  // Name: a single field, or first + last.
  const first = str(body.first_name, 80);
  const last = str(body.last_name, 80);
  const name = str(body.name, 160) ?? ([first, last].filter(Boolean).join(" ") || null);

  // Everything else the form sent becomes the note on the deal, one line per field.
  const RESERVED = new Set(["form", "email", "phone", "name", "first_name", "last_name", "website", "hp", "page_url", "consent", "sms_consent", "submission_id"]);
  const fields: Record<string, string> = {};
  const extra = (body.fields && typeof body.fields === "object" ? (body.fields as Record<string, unknown>) : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries({ ...body, ...extra })) {
    if (RESERVED.has(k) || k === "fields") continue;
    const s = str(v, 2000);
    if (s) fields[k.slice(0, 60)] = s;
  }
  const pageUrl = str(body.page_url, 500);
  const noteLines = Object.entries(fields).map(([k, v]) => `${k.replace(/[_-]+/g, " ")}: ${v}`);
  if (pageUrl) noteLines.push(`Submitted from ${pageUrl}`);

  const smsConsent = body.sms_consent === true || String(body.sms_consent ?? "").toLowerCase() === "true" || body.sms_consent === "on";

  // Klaviyo first so the result is in the intake log.
  let klaviyo: string | null = null;
  if (src.config.subscribe_list_id && email) {
    try {
      await subscribeToList({
        listId: src.config.subscribe_list_id,
        email,
        phone,
        firstName: first ?? (name ? name.split(/\s+/)[0] : null),
        lastName: last ?? (name && name.includes(" ") ? name.split(/\s+/).slice(1).join(" ") : null),
        smsConsent,
        properties: { [`${formKey}_submitted_at`]: new Date().toISOString(), ...(fields.truck ? { truck: fields.truck } : {}) },
        customSource: `${src.label} form`,
      });
      klaviyo = `subscribed to ${src.config.subscribe_list_name ?? src.config.subscribe_list_id}`;
    } catch (e) {
      klaviyo = `klaviyo failed: ${e instanceof Error ? e.message : "error"}`;
      console.error("web-form klaviyo subscribe failed", e);
    }
  }

  const bucket = Math.floor(Date.now() / 600_000); // 10-minute dedupe window
  const result = await processIntake(db, src, {
    externalId: str(body.submission_id, 120) ?? `${formKey}:${email ?? phone}:${bucket}`,
    email,
    phone,
    name,
    link: pageUrl,
    note: noteLines.join("\n") || null,
    meta: { form: formKey, ip, fields, klaviyo, page_url: pageUrl },
  });

  if (result.action === "error") return json({ ok: false, error: "could not record submission" }, 500, origin);
  return json({ ok: true }, 200, origin);
}
