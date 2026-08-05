import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env, envOptional } from "./env";
import { normalizeEmail, normalizePhone } from "./identity";
import { getProfilePhoneByEmail } from "./klaviyo";
import { upsertDeal, upsertContact } from "./crm-sync";

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
  pipedriveDealId?: number;
  crmDealId?: string;
  title?: string;
  phoneEnriched?: boolean;
}

function pdClient() {
  if (!envOptional("PIPEDRIVE_API_TOKEN")) throw new Error("Pipedrive unavailable");
  const token = env("PIPEDRIVE_API_TOKEN");
  return async (path: string, method = "GET", body?: unknown) => {
    const u = new URL(`https://api.pipedrive.com/v1${path}`);
    u.searchParams.set("api_token", token);
    const res = await fetch(u, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error("Pipedrive daily budget exhausted");
    if (!res.ok || json.success === false) throw new Error(`Pipedrive ${path} ${res.status}`);
    return json.data;
  };
}

/**
 * Source-agnostic deal creation from an email (Klaviyo profile, Shopify
 * customer, automation signal — anything). Finds or creates the Pipedrive
 * person (system of record until cutover), enriches a missing phone from
 * Klaviyo, dedupes against open deals, mirrors immediately.
 */
export async function createDealFromEmail(
  db: SupabaseClient,
  opts: {
    email: string;
    name?: string | null;
    title?: string | null;
    ownerPipedriveId?: number | null;
    pipedriveStageId?: number | null;
    enrichPhone?: boolean;
    skipIfOpenDeal?: boolean;
    sourceName?: string | null;
  }
): Promise<CreateDealResult> {
  const email = normalizeEmail(opts.email);
  if (!email) throw new Error("valid email required");
  const pd = pdClient();

  const search = await pd(
    `/persons/search?term=${encodeURIComponent(email)}&fields=email&exact_match=true&limit=1`
  );
  let personId: number | null = search?.items?.[0]?.item?.id ?? null;

  if (personId && opts.skipIfOpenDeal !== false) {
    const deals = await pd(`/persons/${personId}/deals?status=open&limit=1`);
    if ((deals ?? []).length > 0) {
      return { created: false, skippedReason: "open deal already exists for this person" };
    }
  }

  let phone: string | null = null;
  if (opts.enrichPhone !== false && envOptional("KLAVIYO_PRIVATE_KEY")) {
    phone = normalizePhone(await getProfilePhoneByEmail(email).catch(() => null));
  }

  const displayName = opts.name?.trim() || email.split("@")[0];
  if (!personId) {
    const person = await pd("/persons", "POST", {
      name: displayName,
      email: [{ value: email, primary: true }],
      ...(phone ? { phone: [{ value: phone, primary: true }] } : {}),
      ...(opts.ownerPipedriveId ? { owner_id: opts.ownerPipedriveId } : {}),
    });
    personId = person.id;
    await upsertContact(db, person).catch(() => {});
  } else if (phone) {
    const person = await pd(`/persons/${personId}`);
    const hasPhone = (person.phone ?? []).some((p: any) => p.value);
    if (!hasPhone) {
      const updated = await pd(`/persons/${personId}`, "PUT", {
        phone: [{ value: phone, primary: true }],
      });
      await upsertContact(db, updated).catch(() => {});
    } else {
      phone = null; // person already had one — nothing enriched
    }
  }

  const title = opts.title?.trim() || `Saved Build - ${displayName}`;
  const deal = await pd("/deals", "POST", {
    title,
    person_id: personId,
    ...(opts.pipedriveStageId ? { stage_id: opts.pipedriveStageId } : {}),
    ...(opts.ownerPipedriveId ? { user_id: opts.ownerPipedriveId } : {}),
  });
  await upsertDeal(db, deal);
  const { data: mirrored } = await db
    .from("crm_deals")
    .select("id")
    .eq("pipedrive_deal_id", deal.id)
    .maybeSingle();
  if (mirrored && opts.sourceName) {
    await setDealSourceByName(db, mirrored.id, opts.sourceName);
  }

  return {
    created: true,
    pipedriveDealId: deal.id,
    crmDealId: mirrored?.id,
    title,
    phoneEnriched: Boolean(phone),
  };
}

/**
 * Deal creation from a phone number — the manual-dial "no deal matched" path.
 * Finds or creates the Pipedrive person by phone; if that person already has
 * an open deal, links to it instead of creating a duplicate.
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
  const pd = pdClient();

  const digits = phone.replace(/\D/g, "").replace(/^1/, "");
  const search = await pd(
    `/persons/search?term=${encodeURIComponent(digits)}&fields=phone&limit=1`
  );
  let personId: number | null = search?.items?.[0]?.item?.id ?? null;

  if (personId) {
    const deals = await pd(`/persons/${personId}/deals?status=open&limit=1`);
    const open = (deals ?? [])[0];
    if (open) {
      await upsertDeal(db, open);
      const { data: mirrored } = await db
        .from("crm_deals")
        .select("id")
        .eq("pipedrive_deal_id", open.id)
        .maybeSingle();
      return {
        created: false,
        skippedReason: "linked to this person's existing open deal",
        pipedriveDealId: open.id,
        crmDealId: mirrored?.id,
        title: open.title,
      };
    }
  }

  const displayName = opts.name?.trim() || phone;
  const email = opts.email ? normalizeEmail(opts.email) : null;
  if (!personId) {
    const person = await pd("/persons", "POST", {
      name: displayName,
      phone: [{ value: phone, primary: true }],
      ...(email ? { email: [{ value: email, primary: true }] } : {}),
      ...(opts.ownerPipedriveId ? { owner_id: opts.ownerPipedriveId } : {}),
    });
    personId = person.id;
    await upsertContact(db, person).catch(() => {});
  }

  const title = opts.title?.trim() || `Phone Lead - ${displayName}`;
  const deal = await pd("/deals", "POST", {
    title,
    person_id: personId,
    ...(opts.pipedriveStageId ? { stage_id: opts.pipedriveStageId } : {}),
    ...(opts.ownerPipedriveId ? { user_id: opts.ownerPipedriveId } : {}),
  });
  await upsertDeal(db, deal);
  const { data: mirrored } = await db
    .from("crm_deals")
    .select("id")
    .eq("pipedrive_deal_id", deal.id)
    .maybeSingle();
  if (mirrored && opts.sourceName) {
    await setDealSourceByName(db, mirrored.id, opts.sourceName);
  }

  return { created: true, pipedriveDealId: deal.id, crmDealId: mirrored?.id, title };
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
