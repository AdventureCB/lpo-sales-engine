import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { normalizePhone, normalizeEmail } from "@/lib/identity";
import { enqueuePdSync } from "@/lib/pd-sync";

export const runtime = "nodejs";

interface Phone { value: string; e164?: string; primary?: boolean; label?: string; bad?: boolean; bad_at?: string }
interface Email { value: string; primary?: boolean }

/**
 * Edit a CRM contact: name, phones, emails (add / edit / remove / set
 * primary). CRM-first; Pipedrive follows via the person_update outbox.
 * No `op` = legacy add (used by manual add + Klaviyo enrichment).
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    contactId?: string;
    op?: string;
    phone?: string;
    email?: string;
    source?: string;
    firstName?: string;
    lastName?: string;
    value?: string; // target phone/email for edit/remove/primary
    newValue?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.contactId) return NextResponse.json({ error: "contactId required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: contact } = await db
    .from("crm_contacts")
    .select("id, name, first_name, last_name, phones, emails, pipedrive_person_id")
    .eq("id", body.contactId)
    .maybeSingle();
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });

  let phones = [...((contact.phones as Phone[]) ?? [])];
  let emails = [...((contact.emails as Email[]) ?? [])];
  const upd: Record<string, unknown> = {};
  const phoneKey = (p: Phone) => p.e164 ?? normalizePhone(p.value) ?? p.value;

  switch (body.op) {
    case "rename": {
      const first = (body.firstName ?? "").trim();
      const last = (body.lastName ?? "").trim();
      const name = [first, last].filter(Boolean).join(" ") || first || last;
      if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
      upd.first_name = first || null;
      upd.last_name = last || null;
      upd.name = name;
      break;
    }
    case "set_primary_phone": {
      const target = normalizePhone(body.value ?? "");
      phones = phones.map((p) => ({ ...p, primary: phoneKey(p) === target }));
      upd.phones = phones;
      break;
    }
    case "set_primary_email": {
      const target = normalizeEmail(body.value ?? "");
      emails = emails.map((e) => ({ ...e, primary: (e.value ?? "").toLowerCase() === target }));
      upd.emails = emails;
      break;
    }
    case "remove_phone": {
      const target = normalizePhone(body.value ?? "");
      phones = phones.filter((p) => phoneKey(p) !== target);
      if (phones.length && !phones.some((p) => p.primary)) phones[0].primary = true;
      upd.phones = phones;
      break;
    }
    case "remove_email": {
      const target = normalizeEmail(body.value ?? "");
      emails = emails.filter((e) => (e.value ?? "").toLowerCase() !== target);
      if (emails.length && !emails.some((e) => e.primary)) emails[0].primary = true;
      upd.emails = emails;
      break;
    }
    case "edit_phone": {
      const target = normalizePhone(body.value ?? "");
      const next = normalizePhone(body.newValue ?? "");
      if (!next) return NextResponse.json({ error: "invalid phone" }, { status: 400 });
      // A corrected number is presumed good again — clear the bad strike.
      phones = phones.map((p) => (phoneKey(p) === target ? { ...p, value: next, e164: next, bad: false, bad_at: undefined } : p));
      upd.phones = phones;
      break;
    }
    case "toggle_bad_phone": {
      const target = normalizePhone(body.value ?? "");
      phones = phones.map((p) =>
        phoneKey(p) === target
          ? { ...p, bad: !p.bad, bad_at: !p.bad ? new Date().toISOString() : undefined }
          : p
      );
      upd.phones = phones;
      break;
    }
    case "edit_email": {
      const target = normalizeEmail(body.value ?? "");
      const next = normalizeEmail(body.newValue ?? "");
      if (!next) return NextResponse.json({ error: "invalid email" }, { status: 400 });
      emails = emails.map((e) => ((e.value ?? "").toLowerCase() === target ? { ...e, value: next } : e));
      upd.emails = emails;
      break;
    }
    default: {
      // Legacy add: phone and/or email.
      const phone = body.phone ? normalizePhone(body.phone) : null;
      const email = body.email ? normalizeEmail(body.email) : null;
      if (body.phone && !phone) return NextResponse.json({ error: "invalid phone" }, { status: 400 });
      if (body.email && !email) return NextResponse.json({ error: "invalid email" }, { status: 400 });
      if (!phone && !email) return NextResponse.json({ error: "phone or email required" }, { status: 400 });
      if (phone) {
        if (phones.some((p) => phoneKey(p) === phone)) {
          return NextResponse.json({ error: "phone already on contact" }, { status: 409 });
        }
        phones.push({ value: phone, e164: phone, primary: phones.length === 0, label: body.source ?? "manual" });
        upd.phones = phones;
      }
      if (email) {
        if (emails.some((e) => (e.value ?? "").toLowerCase() === email)) {
          return NextResponse.json({ error: "email already on contact" }, { status: 409 });
        }
        emails.push({ value: email, primary: emails.length === 0 });
        upd.emails = emails;
      }
    }
  }

  upd.updated_at = new Date().toISOString();
  const { error } = await db.from("crm_contacts").update(upd).eq("id", contact.id);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  if (contact.pipedrive_person_id) {
    await enqueuePdSync(db, "person_update", {
      personId: contact.pipedrive_person_id,
      name: (upd.name as string) ?? undefined,
      phones: phones.map((p) => ({ value: p.e164 ?? p.value, primary: !!p.primary })),
      emails: emails.map((e) => ({ value: e.value, primary: !!e.primary })),
    });
  }

  return NextResponse.json({ ok: true, name: upd.name ?? contact.name, phones, emails });
}
