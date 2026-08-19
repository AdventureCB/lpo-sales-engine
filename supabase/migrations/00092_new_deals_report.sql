-- Ad-ROI "new deals" counters: deals born in a date range (LA-local,
-- inclusive), bucketed by day/week/month + a per-source breakdown. Birth =
-- pd_add_time (original Pipedrive creation) falling back to created_at for
-- native deals, so history back-loads as far as the mirror goes.

create or replace function public.new_deals_report(p_start date, p_end date, p_bucket text)
returns jsonb
language sql
stable
as $$
  with deals as (
    select (coalesce(d.pd_add_time, d.created_at) at time zone 'America/Los_Angeles') as born_la,
           s.name as source
    from crm_deals d
    left join deal_sources s on s.id = d.source_id
    where (coalesce(d.pd_add_time, d.created_at) at time zone 'America/Los_Angeles')::date
          between p_start and p_end
  ),
  buckets as (
    select to_char(date_trunc(case when p_bucket in ('day','week','month') then p_bucket else 'day' end, born_la), 'YYYY-MM-DD') as key,
           count(*) as n
    from deals
    group by 1
  ),
  by_source as (
    select coalesce(source, 'No source') as source, count(*) as n
    from deals
    group by 1
  )
  select jsonb_build_object(
    'total', (select count(*) from deals),
    'buckets', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', n) order by key) from buckets), '[]'::jsonb),
    'bySource', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'count', n) order by n desc, source) from by_source), '[]'::jsonb)
  );
$$;
