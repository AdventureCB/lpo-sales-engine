import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env, envOptional } from "./env";
import { normalizeEmail, normalizePhone } from "./identity";
import { getProfilePhoneByEmail } from "./klaviyo";
import { upsertDeal, upsertContact } from "./crm-sync";

export interface CreateDealResult {
  created: boolean;
  skippedReason?: string;
  pipedriveDealId?: number;
  crmDealId?: string;
  title?: string;
  phoneEnriched?: boolean;
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
  }
): Promise<CreateDealResult> {
  const email = normalizeEmail(opts.email);
  if (!email) throw new Error("valid email required");
  if (!envOptional("PIPEDRIVE_API_TOKEN")) throw new Error("Pipedrive unavailable");

  const token = env("PIPEDRIVE_API_TOKEN");
  const pd = async (path: string, method = "GET", body?: unknown) => {
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

  return {
    created: true,
    pipedriveDealId: deal.id,
    crmDealId: mirrored?.id,
    title,
    phoneEnriched: Boolean(phone),
  };
}
