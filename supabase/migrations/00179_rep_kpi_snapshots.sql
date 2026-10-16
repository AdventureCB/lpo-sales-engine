-- Rep KPIs: (1) campaign sends count as a touch only when a REP triggered them
-- (enrolled a deal by hand, or approved the send in the Outbox) — automatic
-- state-trigger sends are not rep effort (Kyle 10/16); (2) results are
-- snapshotted hourly instead of recomputed on every page load.

create or replace function rep_deal_touches(p_window_start timestamptz)
returns table (rep_email text, deal_id uuid, first_touch timestamptz, last_touch timestamptz, touches_window bigint, touches_total bigint)
language sql stable security definer set search_path = public as $$
  with calls as (
    select r.email as rep_email, coalesce(c.crm_deal_id, d.id) as deal_id, c.started_at as at
    from call_events c
    join reps r on r.id = c.rep_id
    left join crm_deals d on c.crm_deal_id is null and d.pipedrive_deal_id = c.deal_id
    where (c.direction = 'outgoing' or (c.direction = 'incoming' and c.answered_at is not null))
  ),
  acts as (
    select lower(a.actor) as rep_email, a.deal_id, a.occurred_at as at
    from crm_activities a
    left join campaign_sends s on s.id = nullif(a.meta->>'campaign_send_id', '')::uuid
    left join campaign_enrollments e on e.id = s.enrollment_id
    where a.actor like '%@%'
      and a.due_at is null
      and a.deal_id is not null
      and (
        a.type in ('sms', 'call', 'meeting')
        or (a.type = 'email' and coalesce(a.meta->>'direction', 'outbound') not in ('inbound', 'internal'))
      )
      -- campaign send: only when a rep triggered it (manual enrollment or Outbox approval)
      and (a.meta->>'campaign_send_id' is null or coalesce(s.approved_by, '') like '%@%' or coalesce(e.enrolled_by, '') like '%@%')
  ),
  touches as (select * from calls where deal_id is not null union all select * from acts)
  select rep_email, deal_id, min(at), max(at),
         count(*) filter (where at >= p_window_start), count(*)
  from touches group by rep_email, deal_id;
$$;

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
    left join campaign_sends s on s.id = nullif(a.meta->>'campaign_send_id', '')::uuid
    left join campaign_enrollments e on e.id = s.enrollment_id
    where lower(a.actor) = lower(p_rep_email) and a.due_at is null and a.deal_id is not null and a.occurred_at >= p_since
      and (a.type in ('sms','call','meeting') or (a.type = 'email' and coalesce(a.meta->>'direction','outbound') not in ('inbound','internal')))
      and (a.meta->>'campaign_send_id' is null or coalesce(s.approved_by, '') like '%@%' or coalesce(e.enrolled_by, '') like '%@%')
  ),
  t as (select * from calls union all select * from acts)
  select (date_trunc('week', at at time zone 'America/Los_Angeles'))::date as week,
         count(*), count(distinct deal_id),
         count(*) filter (where kind = 'dial'),
         count(*) filter (where kind = 'conv' or connected),
         count(*) filter (where kind = 'email'),
         count(*) filter (where kind = 'text')
  from t group by 1 order by 1;
$$;

create table if not exists rep_kpi_snapshots (
  days smallint not null,
  rep_email text not null,
  computed_at timestamptz not null default now(),
  payload jsonb not null,        -- the per-rep KPI object the page renders
  weekly jsonb,                  -- 12-week activity series (same for every window)
  primary key (days, rep_email)
);
alter table rep_kpi_snapshots enable row level security;

select cron.schedule('rep-kpis-hourly', '40 * * * *', $cron$
  select net.http_get(
    url := 'https://lpo-sales-engine.vercel.app/api/cron/rep-kpis',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')),
    timeout_milliseconds := 115000)
$cron$);
