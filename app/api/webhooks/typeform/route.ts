import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { envOptional } from "@/lib/env";
import { matchSubmission } from "@/lib/typeform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Typeform webhook: each survey submission carries the ad identity (URL
 * parameters / hidden fields: utm_*, fbclid, gclid, vid) + the respondent's
 * email. Stored raw, then matched to the CRM contact by email — the deal
 * gets its actual advertising id. Submissions that arrive before the
 * Klaviyo→Pipedrive pipeline creates the contact are retried by cron.
 */

function verifySignature(raw: string, req: NextRequest): boolean {
  const secret = envOptional("TYPEFORM_WEBHOOK_SECRET");
  if (!secret) return true; // not configured yet — accept (endpoint is obscure, data is inert)
  const sig = req.headers.get("typeform-signature") ?? "";
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifySignature(raw, req)) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const fr = body?.form_response;
  if (body?.event_type !== "form_response" || !fr) return NextResponse.json({ ok: true, ignored: true });

  const email =
    (fr.answers ?? []).find((a: any) => a?.type === "email" && a?.email)?.email?.toLowerCase()?.trim() ?? null;
  const hidden: Record<string, unknown> = fr.hidden ?? {};
  const formName = fr.definition?.title ?? null;

  const db = supabaseAdmin();
  const { data: row, error } = await db
    .from("typeform_submissions")
    .upsert(
      {
        event_id: String(body.event_id ?? fr.token ?? crypto.randomUUID()).slice(0, 100),
        form_id: fr.form_id ?? null,
        form_name: formName,
        email,
        submitted_at: fr.submitted_at ?? new Date().toISOString(),
        hidden,
      },
      { onConflict: "event_id" }
    )
    .select("id, email, hidden, submitted_at")
    .single();
  if (error || !row) return NextResponse.json({ error: "db error" }, { status: 500 });

  const matched = await matchSubmission(db, row as any);

  // ── Intake Engine routing (Zapier "quote survey → INTAKE ENGINE" parity) ──
  // A typeform-adapter engine matching this form creates/notes the deal
  // directly — with answers as the first note and hidden ad params attached.
  let intakeAction: string | null = null;
  try {
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
    if (engine && email) {
      const cfg = (engine as any).config ?? {};
      if (!cfg.typeform_form_id && fr.form_id) {
        await db
          .from("intake_sources")
          .update({ config: { ...cfg, typeform_form_id: fr.form_id }, updated_at: new Date().toISOString() })
          .eq("id", (engine as any).id);
      }
      // Field extraction by title/ref: first+last name, phone, and a
      // notes summary of every answer (the Zap's notes_summary).
      const titleById = new Map<string, string>(
        ((fr.definition?.fields ?? []) as any[]).map((f) => [f.id, f.title ?? f.ref ?? ""])
      );
      const val = (a: any): string =>
        a.text ?? a.email ?? a.phone_number ?? a.number?.toString() ?? a.choice?.label ??
        (Array.isArray(a.choices?.labels) ? a.choices.labels.join(", ") : null) ?? a.date ?? a.boolean?.toString() ?? "";
      let first = "", last = "", phone: string | null = null;
      const qa: string[] = [];
      for (const a of (fr.answers ?? []) as any[]) {
        const title = titleById.get(a.field?.id) ?? a.field?.ref ?? "";
        const v = val(a);
        if (!v) continue;
        if (a.type === "phone_number") phone = v;
        else if (/first/i.test(title) && !first) first = v;
        else if (/last/i.test(title) && !last) last = v;
        if (a.type !== "email") qa.push(`${title || a.type}: ${v}`);
      }
      const { processIntake } = await import("@/lib/intake");
      const res = await processIntake(db, engine as any, {
        externalId: String(body.event_id ?? fr.token ?? "").slice(0, 100) || null,
        email,
        phone,
        name: [first, last].filter(Boolean).join(" ") || null,
        note: qa.join("\n").slice(0, 1500) || null,
        occurredAt: fr.submitted_at ?? null,
        meta: { form_id: fr.form_id, form_name: formName, source_channel_id: (engine as any).channel_id, hidden },
      });
      intakeAction = res.action;
    }
  } catch (e) {
    console.error("typeform intake routing failed", e);
  }

  return NextResponse.json({ ok: true, matched, intakeAction });
}
