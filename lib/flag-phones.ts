import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { envOptional } from "./env";
import { normalizePhone } from "./identity";
import { getProfilePhoneByEmail } from "./klaviyo";

interface FlagWithPhone {
  deal_id: number;
  person_phone?: string | null;
}

/**
 * Fallback phone source: flags whose Pipedrive person had no number get one
 * from the Klaviyo profile matching the deal's engagement email. Persisted on
 * the flag so each deal is looked up at most once. Mutates the passed flags.
 */
export async function fillMissingFlagPhones(
  db: SupabaseClient,
  flags: FlagWithPhone[]
): Promise<void> {
  if (!envOptional("KLAVIYO_PRIVATE_KEY")) return;
  const missing = flags.filter((f) => !f.person_phone).slice(0, 10); // cap per request
  for (const f of missing) {
    try {
      const { data: ev } = await db
        .from("engagement_events")
        .select("person_email")
        .eq("pipedrive_deal_id", f.deal_id)
        .not("person_email", "is", null)
        .order("occurred_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!ev?.person_email) continue;
      const phone = normalizePhone(await getProfilePhoneByEmail(ev.person_email));
      if (!phone) continue;
      await db
        .from("hot_flags")
        .update({ person_phone: phone })
        .eq("deal_id", f.deal_id)
        .is("person_phone", null);
      f.person_phone = phone;
    } catch (e) {
      console.error(`klaviyo phone fill failed for deal ${f.deal_id}`, e);
    }
  }
}
