-- Move the Klaviyo SMS-consent match into Postgres. The Node cron used to
-- page all 22k contacts into a JS map every run (the heaviest per-run Node
-- job); now it just hands Postgres the subscribed emails and this does the
-- matching in one indexed statement.

-- Case-insensitive, indexable email set for a contact (emails is
-- [{value, primary}]). Immutable so it can back a functional GIN index.
create or replace function public.contact_email_set(emails jsonb)
returns text[]
language sql
immutable
as $$
  select coalesce(
    array_agg(lower(e->>'value')) filter (where nullif(e->>'value', '') is not null),
    '{}'::text[]
  )
  from jsonb_array_elements(coalesce(emails, '[]'::jsonb)) e
$$;

create index if not exists idx_crm_contacts_email_set
  on crm_contacts using gin (public.contact_email_set(emails));

-- Apply Klaviyo SUBSCRIBED consent to matching contacts, but only where no
-- consent is recorded yet — explicit survey answers and STOPs outrank an
-- inferred Klaviyo subscription. Positionally-zipped emails/timestamps.
create or replace function public.apply_klaviyo_consent(p_emails text[], p_ats timestamptz[])
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  with b as (
    select distinct on (lower(trim(u.email)))
           lower(trim(u.email)) as email, u.at
    from unnest(p_emails, p_ats) as u(email, at)
    where nullif(trim(u.email), '') is not null
    order by lower(trim(u.email)), u.at nulls last
  ),
  upd as (
    update crm_contacts c
    set sms_consent = 'opted_in',
        sms_consent_at = coalesce(b.at, now()),
        sms_consent_source = 'Klaviyo',
        updated_at = now()
    from b
    where c.sms_consent is null
      and public.contact_email_set(c.emails) @> array[b.email]
    returning 1
  )
  select count(*) into n from upd;
  return n;
end
$$;
