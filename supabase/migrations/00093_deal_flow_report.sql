-- Ad-ROI deal-flow: new (born) / won (won_at) / lost (lost_at) counts per
-- day|week|month bucket in an LA-local inclusive range, optional source
-- filter, plus totals (incl. current open snapshot for the source) and a
-- per-source breakdown of range births. Supersedes new_deals_report's shape
-- (kept for compatibility).

create or replace function public.deal_flow_report(
  p_start date, p_end date, p_bucket text, p_source text default null
)
returns jsonb
language sql
stable
as $$
  with base as (
    select d.*, s.name as source_name
    from crm_deals d
    left join deal_sources s on s.id = d.source_id
    where p_source is null or s.name = p_source
  ),
  bk as (select case when p_bucket in ('day','week','month') then p_bucket else 'day' end as b),
  born as (
    select to_char(date_trunc((select b from bk), coalesce(pd_add_time, created_at) at time zone 'America/Los_Angeles'), 'YYYY-MM-DD') as key,
           source_name
    from base
    where (coalesce(pd_add_time, created_at) at time zone 'America/Los_Angeles')::date between p_start and p_end
  ),
  wons as (
    select to_char(date_trunc((select b from bk), won_at at time zone 'America/Los_Angeles'), 'YYYY-MM-DD') as key
    from base
    where won_at is not null and (won_at at time zone 'America/Los_Angeles')::date between p_start and p_end
  ),
  losts as (
    select to_char(date_trunc((select b from bk), lost_at at time zone 'America/Los_Angeles'), 'YYYY-MM-DD') as key
    from base
    where lost_at is not null and (lost_at at time zone 'America/Los_Angeles')::date between p_start and p_end
  ),
  keys as (
    select key from born union select key from wons union select key from losts
  ),
  series as (
    select k.key,
           (select count(*) from born where born.key = k.key) as n_new,
           (select count(*) from wons where wons.key = k.key) as n_won,
           (select count(*) from losts where losts.key = k.key) as n_lost
    from keys k
  ),
  by_source as (
    select coalesce(source_name, 'No source') as source, count(*) as n
    from born
    group by 1
  )
  select jsonb_build_object(
    'series', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'new', n_new, 'won', n_won, 'lost', n_lost) order by key) from series), '[]'::jsonb),
    'totals', jsonb_build_object(
      'new', (select count(*) from born),
      'won', (select count(*) from wons),
      'lost', (select count(*) from losts),
      'openNow', (select count(*) from base where status = 'open')
    ),
    'bySource', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'count', n) order by n desc, source) from by_source), '[]'::jsonb)
  );
$$;
