-- Background Klaviyo phone adoption (Kyle 9/23): saved-build (and other)
-- deals often arrive without a phone while Klaviyo has one — and a deal with
-- no phone never reaches the sprint lists, so reps never see it. This RPC
-- feeds the sweep in lib/klaviyo-phone-adopt.ts: open deals whose contact has
-- no usable phone (none, or all flagged bad), newest deal first, skipping
-- contacts we re-checked recently and found nothing.
create or replace function public.contacts_needing_phone(p_limit int default 40)
returns table (contact_id uuid, email text, deal_id uuid, cached_phones jsonb, cache_fresh boolean)
language sql stable security definer set search_path = public as $$
  select x.contact_id, x.email, x.deal_id, x.cached_phones, x.cache_fresh from (
    select distinct on (c.id)
      c.id as contact_id,
      lower(c.emails->0->>'value') as email,
      d.id as deal_id,
      kp.phones as cached_phones,
      (kp.updated_at is not null and kp.updated_at > now() - interval '24 hours') as cache_fresh,
      d.created_at
    from crm_deals d
    join crm_contacts c on c.id = d.contact_id
    left join klaviyo_profiles kp on kp.email = lower(c.emails->0->>'value')
    where d.status = 'open'
      and coalesce(c.dnc, false) = false
      and c.emails->0->>'value' like '%@%'
      and not exists (
        select 1 from jsonb_array_elements(coalesce(c.phones, '[]'::jsonb)) p
        where coalesce((p->>'bad')::boolean, false) = false
      )
      -- Checked recently with nothing found: daily re-check, weekly when Klaviyo has no profile at all.
      and not (
        kp.updated_at is not null
        and (kp.phones is null or jsonb_array_length(kp.phones) = 0)
        and kp.updated_at > now() - (case when kp.profile_id = 'none' then interval '7 days' else interval '24 hours' end)
      )
    order by c.id, d.created_at desc
  ) x
  order by x.created_at desc
  limit p_limit
$$;
