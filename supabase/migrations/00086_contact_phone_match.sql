-- Texting a contact from the CRM must resolve their NAME on the Texts page.
-- contacts_by_phones matched on exact {"e164": phone} jsonb containment, so
-- contacts whose phone entry is stored value-only (or formatted differently)
-- never linked. Match on the last 10 digits instead, via an indexable
-- functional set (same pattern as contact_email_set, migration 00065).

create or replace function public.contact_phone_set(phones jsonb)
returns text[]
language sql
immutable
as $$
  select coalesce(
    array_agg(distinct right(regexp_replace(coalesce(p->>'e164', p->>'value', ''), '\D', '', 'g'), 10))
      filter (where nullif(regexp_replace(coalesce(p->>'e164', p->>'value', ''), '\D', '', 'g'), '') is not null),
    '{}'::text[]
  )
  from jsonb_array_elements(coalesce(phones, '[]'::jsonb)) p
$$;

create index if not exists idx_crm_contacts_phone_set
  on crm_contacts using gin (public.contact_phone_set(phones));

create or replace function public.contacts_by_phones(p_phones text[])
returns table(phone text, contact_id uuid, contact_name text, crm_deal_id uuid, deal_title text)
language sql stable as $$
  select p.phone, c.id, c.name, d.id, d.title
  from unnest(p_phones) as p(phone)
  join crm_contacts c
    on public.contact_phone_set(c.phones)
       @> array[right(regexp_replace(p.phone, '\D', '', 'g'), 10)]
  left join lateral (
    select id, title from crm_deals
    where contact_id = c.id
    order by (status = 'open') desc, updated_at desc
    limit 1
  ) d on true
$$;
