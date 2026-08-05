-- Per-rep daily dial/connect/talk rollup for the dialer's momentum panel
-- (goal progress, personal best, streak). ≤90 rows per call — no row-cap risk.

create or replace function rep_daily_dials(p_rep uuid, p_tz text default 'America/Los_Angeles')
returns table(day date, dials bigint, connects bigint, talk_s bigint)
language sql stable as $$
  select
    (started_at at time zone p_tz)::date as day,
    count(*) filter (where direction = 'outgoing') as dials,
    count(*) filter (where direction = 'outgoing' and disposition = 'connected') as connects,
    coalesce(sum(duration_s) filter (where direction = 'outgoing' and disposition = 'connected'), 0) as talk_s
  from call_events
  where rep_id = p_rep
    and started_at > now() - interval '90 days'
  group by 1
  order by 1 desc
$$;
