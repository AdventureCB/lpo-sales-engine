-- Rep dashboard: weekly activity series for one rep (same touch definition as
-- rep_deal_touches). Weeks start Monday, Pacific.
create or replace function rep_weekly_touches(p_rep_email text, p_since timestamptz)
returns table (week date, touches bigint, deals bigint, dials bigint, conversations bigint, emails bigint, texts bigint)
language sql stable security definer set search_path = public as $$
  with calls as (
    select coalesce(c.crm_deal_id, d.id) as deal_id, c.started_at as at,
           case when c.direction = 'outgoing' then 'dial' else 'conv' end as kind,
           (c.direction = 'outgoing' and (c.disposition = 'connected' or c.classification = 'conversation')) as connected
    from call_events c
    join reps r on r.id = c.rep_id and lower(r.email) = lower(p_rep_email)
    left join crm_deals d on c.crm_deal_id is null and d.pipedrive_deal_id = c.deal_id
    where c.started_at >= p_since
      and (c.direction = 'outgoing' or (c.direction = 'incoming' and c.answered_at is not null))
  ),
  acts as (
    select a.deal_id, a.occurred_at as at,
           case when a.type = 'email' then 'email' when a.type = 'sms' then 'text' else 'other' end as kind,
           false as connected
    from crm_activities a
    where lower(a.actor) = lower(p_rep_email) and a.due_at is null and a.deal_id is not null and a.occurred_at >= p_since
      and (a.type in ('sms','call','meeting') or (a.type = 'email' and coalesce(a.meta->>'direction','outbound') not in ('inbound','internal')))
  ),
  t as (select * from calls union all select * from acts)
  select (date_trunc('week', at at time zone 'America/Los_Angeles'))::date as week,
         count(*) as touches,
         count(distinct deal_id) as deals,
         count(*) filter (where kind = 'dial') as dials,
         count(*) filter (where kind = 'conv' or connected) as conversations,
         count(*) filter (where kind = 'email') as emails,
         count(*) filter (where kind = 'text') as texts
  from t
  group by 1 order by 1;
$$;
