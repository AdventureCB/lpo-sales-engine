-- ai_refresh_candidates only looked at crm_activities call bodies — the
-- Quo-era transcript home. Telnyx-era Deepgram transcripts live in
-- call_events.raw->'transcript' and never become activity bodies, so deals
-- with only post-port calls were never picked up for a profile refresh.
-- Union both transcript sources (call_events matched by crm_deal_id
-- native-first, pipedrive_deal_id as legacy fallback).

create or replace function public.ai_refresh_candidates(p_limit integer, p_since_days integer)
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
  group by t.deal_id
  order by max(t.at) desc
  limit p_limit
$function$;
