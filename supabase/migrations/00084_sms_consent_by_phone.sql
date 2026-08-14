-- Sync SMS consent from inbound Telnyx keywords. An inbound STOP marks the
-- matching contact opted_out; START/UNSTOP re-opts them in. Both are explicit
-- customer actions, so they win over any prior value (unlike inferred Klaviyo
-- consent, which only fills nulls). Matches on the last 10 digits of any phone
-- the contact has.
create or replace function public.set_sms_consent_by_phone(p_phone text, p_consent text)
returns integer
language plpgsql
as $$
declare
  n integer;
  last10 text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
begin
  if last10 = '' or p_consent is null then return 0; end if;
  update crm_contacts c
  set sms_consent = p_consent,
      sms_consent_at = now(),
      sms_consent_source = 'Telnyx SMS',
      updated_at = now()
  where exists (
    select 1
    from jsonb_array_elements(coalesce(c.phones, '[]'::jsonb)) ph
    where right(regexp_replace(coalesce(ph->>'e164', ph->>'value', ''), '\D', '', 'g'), 10) = last10
  );
  get diagnostics n = row_count;
  return n;
end
$$;
