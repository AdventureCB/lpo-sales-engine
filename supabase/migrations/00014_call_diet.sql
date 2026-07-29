-- Pipedrive daily API budget exhaustion fixes:
-- 1. Scoring aggregates computed in one SQL call instead of paging thousands
--    of rows to the function (also fixes flag deferral from slow pagination).
-- 2. Queue counts persisted from real builds so the queue list never spends
--    API calls just to show numbers.

create or replace function score_hot_candidates(
  window_start timestamptz,
  click_window_hours int,
  distinct_window_hours int
) returns table (
  deal_id bigint,
  opens bigint,
  clicks bigint,
  distinct_types bigint
) language sql stable as $$
  select
    e.pipedrive_deal_id,
    count(*) filter (where e.type like '%open' and e.occurred_at >= window_start),
    count(*) filter (where e.type like '%click'
      and e.occurred_at >= now() - make_interval(hours => click_window_hours)),
    (select count(distinct e2.source || ':' || e2.type)
       from engagement_events e2
      where e2.pipedrive_deal_id = e.pipedrive_deal_id
        and e2.occurred_at >= now() - make_interval(hours => distinct_window_hours))
  from engagement_events e
  where e.pipedrive_deal_id is not null
    and e.occurred_at >= window_start
  group by e.pipedrive_deal_id
$$;

create table queue_counts (
  queue_id uuid not null references queue_config (id) on delete cascade,
  actor text not null,
  owner_scope text not null,
  count integer not null,
  updated_at timestamptz not null default now(),
  primary key (queue_id, actor, owner_scope)
);

alter table queue_counts enable row level security;
