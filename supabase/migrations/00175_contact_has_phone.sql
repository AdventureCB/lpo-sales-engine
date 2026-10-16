-- CRM list filter "deals without a phone number" (Kyle 10/16). A usable phone =
-- any entry not flagged bad with an e164 or raw value. Generated column so the
-- list can filter through the embedded contact join without scanning jsonb.
alter table crm_contacts add column if not exists has_usable_phone boolean
  generated always as (
    jsonb_path_exists(coalesce(phones, '[]'::jsonb), '$[*] ? (!(@.bad == true) && (exists(@.e164) || exists(@.value)))')
  ) stored;
create index if not exists idx_crm_contacts_has_phone on crm_contacts (has_usable_phone);
