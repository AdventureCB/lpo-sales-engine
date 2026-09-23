-- Drill-down behind the Ad ROI "Lead contact funnel" cards (Kyle 9/23): the
-- deals themselves, with first-attempt / first-contact timestamps, using the
-- SAME attempt/contact definitions as lead_contact_funnel() so the list
-- reconciles with the card numbers. p_scope 'all' = all-time leads,
-- 'new' = leads created in the last p_days.
create or replace function public.lead_contact_funnel_deals(
  p_days integer,
  p_exclude_hotlist boolean default false,
  p_scope text default 'new',
  p_limit integer default 3000
)
returns table (
  id uuid, title text, created_at timestamptz, status text, stage text, source text, owner text,
  contact_name text, has_phone boolean, attempt_at timestamptz, contact_at timestamptz
)
language sql
stable
as $$
with attempts as (
  select crm_id, min(first_at) as first_at from (
    select coalesce(ce.crm_deal_id, d2.id) as crm_id, min(ce.started_at) as first_at
    from call_events ce
    left join crm_deals d2 on ce.deal_id is not null and d2.pipedrive_deal_id = ce.deal_id
    where ce.direction = 'outgoing'
    group by 1
    union all
    select a.deal_id, min(a.occurred_at)
    from crm_activities a
    where a.type = 'call' and a.actor like '%@%'
    group by 1
  ) u
  where crm_id is not null
  group by crm_id
),
contacts as (
  select coalesce(ce.crm_deal_id, d2.id) as crm_id, min(ce.started_at) as first_at
  from call_events ce
  left join crm_deals d2 on ce.deal_id is not null and d2.pipedrive_deal_id = ce.deal_id
  where ce.disposition = 'connected'
     or (ce.classification = 'conversation' and (ce.disposition is null or ce.disposition = 'connected'))
  group by 1
),
d as (
  select dd.id, dd.title, coalesce(dd.pd_add_time, dd.created_at) as created_at, dd.status, dd.stage_id, dd.source_id,
         dd.owner_pipedrive_id, dd.owner_email, dd.contact_id,
         a.first_at as attempt_at, c.first_at as contact_at
  from crm_deals dd
  left join attempts a on a.crm_id = dd.id
  left join contacts c on c.crm_id = dd.id
  where not (p_exclude_hotlist and dd.source_id in (select id from deal_sources where name ilike 'hot list import'))
)
select d.id, d.title, d.created_at, d.status, s.name as stage, ds.name as source,
       coalesce(r.name, d.owner_email) as owner, cc.name as contact_name,
       exists (
         select 1 from jsonb_array_elements(coalesce(cc.phones, '[]'::jsonb)) p
         where coalesce((p->>'bad')::boolean, false) = false
       ) as has_phone,
       d.attempt_at, d.contact_at
from d
left join crm_stages s on s.id = d.stage_id
left join deal_sources ds on ds.id = d.source_id
left join reps r on r.pipedrive_user_id = d.owner_pipedrive_id
left join crm_contacts cc on cc.id = d.contact_id
where (p_scope = 'all' or d.created_at >= now() - make_interval(days => p_days))
order by d.created_at desc
limit p_limit
$$;
