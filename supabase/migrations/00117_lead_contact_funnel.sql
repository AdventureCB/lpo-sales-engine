-- Lead contact funnel for the Ad ROI page (Kyle 9/9):
--   attempt = first outbound DIAL on the deal (call_events outgoing, plus
--             call activities for the Quo era / dispositions)
--   contact = first answered call >=40s, either direction
-- Totals are all-time; "new_*" are deals created inside the range. Averages
-- exclude firsts that PRE-DATE deal creation (imported history attached to
-- later-created deals would go negative).

create or replace function public.lead_contact_funnel(p_days integer)
returns jsonb
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
  where ce.answered_at is not null and coalesce(ce.duration_s, 0) >= 40
  group by 1
),
d as (
  select dd.id,
         coalesce(dd.pd_add_time, dd.created_at) as created_at,
         a.first_at as attempt_at,
         c.first_at as contact_at
  from crm_deals dd
  left join attempts a on a.crm_id = dd.id
  left join contacts c on c.crm_id = dd.id
),
rng as (
  select * from d where created_at >= now() - make_interval(days => p_days)
)
select jsonb_build_object(
  'total_leads', (select count(*) from d),
  'total_contacted', (select count(*) from d where contact_at is not null),
  'new_leads', (select count(*) from rng),
  'new_attempted', (select count(*) from rng where attempt_at is not null),
  'new_contacted', (select count(*) from rng where contact_at is not null),
  'avg_hours_first_attempt', (
    select round((avg(extract(epoch from (attempt_at - created_at)) / 3600.0))::numeric, 1)
    from rng where attempt_at is not null and attempt_at > created_at
  ),
  'avg_hours_first_contact', (
    select round((avg(extract(epoch from (contact_at - created_at)) / 3600.0))::numeric, 1)
    from rng where contact_at is not null and contact_at > created_at
  )
);
$$;
