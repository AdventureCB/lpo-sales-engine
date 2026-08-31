import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { envOptional } from "./env";
import { normalizeEmail, normalizePhone } from "./identity";
import { getProfilePhoneByEmail } from "./klaviyo";

/**
 * Round-robin owner rotation. Each rotation KEY keeps its own cursor —
 * by default every automation rotates independently, so each lead type
 * (saved builds, abandoned carts, survey responses, …) is individually
 * evenly dispersed. Pool changes are safe: the cursor wraps modulo the
 * current pool size, and adding a rep is just adding their id.
 */
export async function nextRoundRobinOwner(
  db: SupabaseClient,
  pool: number[],
  rotationKey: string
): Promise<number> {
  if (pool.length === 0) throw new Error("empty owner pool");
  const key = `rr:${rotationKey}`;
  const { data } = await db.from("crm_sync_state").select("value").eq("key", key).maybeSingle();
  const lastIndex = typeof (data?.value as any)?.last_index === "number" ? (data!.value as any).last_index : -1;
  const nextIndex = (lastIndex + 1) % pool.length;
  await db
    .from("crm_sync_state")
    .upsert({ key, value: { last_index: nextIndex }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return pool[nextIndex];
}

export interface CreateDealResult {
  created: boolean;
  skippedReason?: string;
  pipedriveDealId?: number; // internal deal number (synthetic ≥900M post-cutover)
  crmDealId?: string;
  title?: string;
  phoneEnriched?: boolean;
}

async function findContactByIdentity(db: SupabaseClient, email: string | null, phone: string | null) {
  if (email) {
    const { data } = await db
      .from("crm_contacts")
      .select("id, name, phones")
      .filter("emails", "cs", JSON.stringify([{ value: email }]))
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  if (phone) {
    const { data } = await db
      .from("crm_contacts")
      .select("id, name, phones")
      .filter("phones", "cs", JSON.stringify([{ e164: phone }]))
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

async function openDealForContact(db: SupabaseClient, contactId: string) {
  const { data } = await db
    .from("crm_deals")
    .select("id, pipedrive_deal_id, title")
    .eq("contact_id", contactId)
    .eq("status", "open")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function createContact(
  db: SupabaseClient,
  args: { name: string; email: string | null; phone: string | null; source?: string | null }
) {
  const [first, ...rest] = args.name.split(/\s+/);
  const { data, error } = await db
    .from("crm_contacts")
    .insert({
      name: args.name,
      first_name: first || null,
      last_name: rest.join(" ") || null,
      emails: args.email ? [{ value: args.email, primary: true }] : [],
      phones: args.phone ? [{ value: args.phone, e164: args.phone, primary: true }] : [],
      ...(args.source ? { source: args.source } : {}),
    })
    .select("id, name, phones")
    .single();
  if (error) throw new Error(`contact create failed: ${error.message}`);
  return data;
}

/** Fill a missing phone on an existing contact; returns true if it was set. */
async function fillContactPhone(db: SupabaseClient, contact: { id: string; phones: unknown }, phone: string) {
  const phones = (contact.phones as any[]) ?? [];
  if (phones.some((p) => p?.e164 || p?.value)) return false;
  await db
    .from("crm_contacts")
    .update({ phones: [{ value: phone, e164: phone, primary: true }], updated_at: new Date().toISOString() })
    .eq("id", contact.id);
  return true;
}

async function stageUuidFromPdId(db: SupabaseClient, pipedriveStageId: number | null | undefined) {
  if (!pipedriveStageId) return null;
  const { data } = await db.from("crm_stages").select("id").eq("pipedrive_stage_id", pipedriveStageId).maybeSingle();
  return data?.id ?? null;
}

async function insertDeal(
  db: SupabaseClient,
  args: {
    title: string;
    contactId: string;
    stageId: string | null;
    ownerPipedriveId: number | null;
    valueCents: number | null;
  }
) {
  const { data, error } = await db
    .from("crm_deals")
    .insert({
      title: args.title,
      contact_id: args.contactId,
      stage_id: args.stageId,
      status: "open",
      value_cents: args.valueCents,
      owner_pipedrive_id: args.ownerPipedriveId,
      stage_changed_at: new Date().toISOString(),
    })
    .select("id, pipedrive_deal_id")
    .single();
  if (error) throw new Error(`deal create failed: ${error.message}`);
  return data;
}

/**
 * Source-agnostic deal creation from an email (Klaviyo profile, Shopify
 * customer, automation signal, a rep's manual entry). NATIVE: finds or
 * creates the crm_contact, enriches a missing phone from Klaviyo, dedupes
 * against open deals, and creates the deal directly in the app — the
 * synthetic-id trigger mints the internal deal number.
 */
export async function createDealFromEmail(
  db: SupabaseClient,
  opts: {
    email: string;
    name?: string | null;
    title?: string | null;
    ownerPipedriveId?: number | null;
    pipedriveStageId?: number | null;
    valueCents?: number | null;
    enrichPhone?: boolean;
    providedPhone?: string | null; // trigger payload already had it — skip Klaviyo
    skipIfOpenDeal?: boolean;
    sourceName?: string | null;
  }
): Promise<CreateDealResult> {
  const email = normalizeEmail(opts.email);
  if (!email) throw new Error("valid email required");

  let contact = await findContactByIdentity(db, email, null);

  if (contact && opts.skipIfOpenDeal !== false) {
    const open = await openDealForContact(db, contact.id);
    if (open) return { created: false, skippedReason: "open deal already exists for this person" };
  }

  let phone: string | null = normalizePhone(opts.providedPhone ?? null);
  if (!phone && opts.enrichPhone !== false && envOptional("KLAVIYO_PRIVATE_KEY")) {
    phone = normalizePhone(await getProfilePhoneByEmail(email).catch(() => null));
  }

  const displayName = opts.name?.trim() || email.split("@")[0];
  if (!contact) {
    contact = await createContact(db, {
      name: displayName,
      email,
      phone,
      source: opts.sourceName,
    });
  } else if (phone) {
    const filled = await fillContactPhone(db, contact, phone);
    if (!filled) phone = null; // person already had one — nothing enriched
  }

  const title = opts.title?.trim() || `Saved Build - ${displayName}`;
  const stageId = await stageUuidFromPdId(db, opts.pipedriveStageId);
  const deal = await insertDeal(db, {
    title,
    contactId: contact.id,
    stageId,
    ownerPipedriveId: opts.ownerPipedriveId ?? null,
    valueCents: opts.valueCents ?? null,
  });
  if (opts.sourceName) await setDealSourceByName(db, deal.id, opts.sourceName).catch(() => {});

  return {
    created: true,
    pipedriveDealId: deal.pipedrive_deal_id,
    crmDealId: deal.id,
    title,
    phoneEnriched: Boolean(phone),
  };
}

/**
 * Deal creation from a phone number — the manual-dial "no deal matched" path.
 * NATIVE: finds or creates the crm_contact by phone; if that person already
 * has an open deal, links to it instead of creating a duplicate.
 */
export async function createDealFromPhone(
  db: SupabaseClient,
  opts: {
    phone: string;
    name?: string | null;
    email?: string | null;
    title?: string | null;
    ownerPipedriveId?: number | null;
    pipedriveStageId?: number | null;
    sourceName?: string | null;
  }
): Promise<CreateDealResult> {
  const phone = normalizePhone(opts.phone);
  if (!phone) throw new Error("valid phone required");
  const email = opts.email ? normalizeEmail(opts.email) : null;

  let contact = await findContactByIdentity(db, email, phone);

  if (contact) {
    const open = await openDealForContact(db, contact.id);
    if (open) {
      return {
        created: false,
        skippedReason: "linked to this person's existing open deal",
        pipedriveDealId: open.pipedrive_deal_id ?? undefined,
        crmDealId: open.id,
        title: open.title ?? undefined,
      };
    }
  }

  const displayName = opts.name?.trim() || phone;
  if (!contact) {
    contact = await createContact(db, {
      name: displayName,
      email,
      phone,
      source: opts.sourceName,
    });
  }

  const title = opts.title?.trim() || `Phone Lead - ${displayName}`;
  const stageId = await stageUuidFromPdId(db, opts.pipedriveStageId);
  const deal = await insertDeal(db, {
    title,
    contactId: contact.id,
    stageId,
    ownerPipedriveId: opts.ownerPipedriveId ?? null,
    valueCents: null,
  });
  if (opts.sourceName) await setDealSourceByName(db, deal.id, opts.sourceName).catch(() => {});

  return { created: true, pipedriveDealId: deal.pipedrive_deal_id, crmDealId: deal.id, title };
}

/** Get-or-create a source by name and stamp it on a CRM deal — the
 * post-Pipedrive attribution path for app-created deals. */
export async function setDealSourceByName(
  db: SupabaseClient,
  crmDealId: string,
  sourceName: string
): Promise<void> {
  const name = sourceName.trim();
  if (!name) return;
  let { data: src } = await db.from("deal_sources").select("id").eq("name", name).maybeSingle();
  if (!src) {
    const { data: ins } = await db
      .from("deal_sources")
      .upsert({ name }, { onConflict: "name", ignoreDuplicates: false })
      .select("id")
      .maybeSingle();
    src = ins ?? null;
  }
  if (src) await db.from("crm_deals").update({ source_id: src.id }).eq("id", crmDealId);
}
