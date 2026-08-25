-- Out-of-scope deals (Confirmation Pipeline / Base Camp List) can never be
-- profiled, but ai_refresh_candidates kept returning them — 10 such deals
-- permanently occupied candidate slots (PER_RUN=15), throttling real
-- refreshes to 5/run. Let the caller pass the profiler's pipeline scope.

create or replace function public.ai_refresh_candidates(p_limit integer, p_since_days integer, p_pipelines text[] default null)
returns table(deal_id uuid)
language sql
stable
as $function$
  with tr as (
    select d.id as deal_id, a.occurred_at as at
    from crm_deals d
    join crm_activities a
      on a.deal_id = d.id and a.type = 'call' and length(coalesce(a.body, '')) > 120
    where d.status = 'open'
    union all
    select d.id, ce.started_at
    from crm_deals d
    join call_events ce
      on (ce.crm_deal_id = d.id or (d.pipedrive_deal_id is not null and ce.deal_id = d.pipedrive_deal_id))
     and length(coalesce(ce.raw->>'transcript', '')) > 120
    where d.status = 'open'
  )
  select t.deal_id
  from tr t
  left join deal_profiles p on p.deal_id = t.deal_id
  where t.at > coalesce(p.last_run_at, timestamptz '2000-01-01')
    and t.at > now() - make_interval(days => p_since_days)
    and (
      p_pipelines is null
      or exists (
        select 1 from crm_deals d2
        join crm_stages s on s.id = d2.stage_id
        join crm_pipelines pp on pp.id = s.pipeline_id
        where d2.id = t.deal_id and pp.name = any(p_pipelines)
      )
    )
  group by t.deal_id
  order by max(t.at) desc
  limit p_limit
$function$;
