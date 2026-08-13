-- Phase 2 background refresh. Candidates = open deals with a call transcript
-- newer than their profile's last run (or never profiled), within a recent
-- window so cost stays bounded. ai_background_on() lets pg_cron skip the whole
-- call (no Vercel boot) unless the profiler is enabled AND not lazy-only.

create or replace function public.ai_refresh_candidates(p_limit int, p_since_days int)
returns table(deal_id uuid)
language sql
stable
as $$
  select d.id
  from crm_deals d
  join crm_activities a
    on a.deal_id = d.id and a.type = 'call' and length(coalesce(a.body, '')) > 120
  left join deal_profiles p on p.deal_id = d.id
  where d.status = 'open'
    and a.occurred_at > coalesce(p.last_run_at, timestamptz '2000-01-01')
    and a.occurred_at > now() - make_interval(days => p_since_days)
  group by d.id
  order by max(a.occurred_at) desc
  limit p_limit
$$;

create or replace function public.ai_background_on()
returns boolean
language sql
stable
as $$
  select coalesce(
    (select (value->>'enabled')::boolean and not coalesce((value->>'lazy_only')::boolean, true)
     from crm_sync_state where key = 'ai_profiler_config'),
    false)
$$;
