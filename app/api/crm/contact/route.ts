import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { normalizePhone, normalizeEmail } from "@/lib/identity";
import { enqueuePdSync } from "@/lib/pd-sync";

export const runtime = "nodejs";

/**
 * Add a phone or email to a CRM contact (manual entry or Klaviyo
 * enrichment). CRM-first; Pipedrive follows via the outbox.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { contactId?: string; phone?: string; email?: string; source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.contactId) return NextResponse.json({ error: "contactId required" }, { status: 400 });
  const phone = body.phone ? normalizePhone(body.phone) : null;
  const email = body.email ? normalizeEmail(body.email) : null;
  if (body.phone && !phone) return NextResponse.json({ error: "invalid phone" }, { status: 400 });
  if (body.email && !email) return NextResponse.json({ error: "invalid email" }, { status: 400 });
  if (!phone && !email) return NextResponse.json({ error: "phone or email required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: contact } = await db
    .from("crm_contacts")
    .select("id, phones, emails, pipedrive_person_id")
    .eq("id", body.contactId)
    .maybeSingle();
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });

  const phones = [...((contact.phones as any[]) ?? [])];
  const emails = [...((contact.emails as any[]) ?? [])];

  if (phone) {
    if (phones.some((p) => (p.e164 ?? normalizePhone(p.value)) === phone)) {
      return NextResponse.json({ error: "phone already on contact" }, { status: 409 });
    }
    phones.push({ value: phone, e164: phone, primary: phones.length === 0, label: body.source ?? "manual" });
  }
  if (email) {
    if (emails.some((e) => (e.value ?? "").toLowerCase() === email)) {
      return NextResponse.json({ error: "email already on contact" }, { status: 409 });
    }
    emails.push({ value: email, primary: emails.length === 0 });
  }

  const { error } = await db
    .from("crm_contacts")
    .update({ phones, emails, updated_at: new Date().toISOString() })
    .eq("id", contact.id);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  if (contact.pipedrive_person_id) {
    await enqueuePdSync(db, "person_update", {
      personId: contact.pipedrive_person_id,
      phones: phones.map((p) => ({ value: p.e164 ?? p.value, primary: !!p.primary })),
      emails: emails.map((e) => ({ value: e.value, primary: !!e.primary })),
    });
  }

  return NextResponse.json({ ok: true, phones, emails });
}
