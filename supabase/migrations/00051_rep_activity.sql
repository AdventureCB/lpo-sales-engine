-- Rep engagement time tracking (admin-only KPI: ≥4h/day engaged in calling).
-- Client tracker flushes ACTIVE intervals only (between/other + its view of
-- talking/dialing); talking/dialing are authoritative from call_events at
-- read time, and idle is computed as the uncovered gap within the day's
-- active span — neither is stored.

create table if not exists rep_activity_intervals (
  id uuid primary key default gen_random_uuid(),
  client_interval_id uuid not null unique,   -- idempotent flushes; open-interval rows grow in place
  rep_email text not null,
  device_id text not null,                   -- per-tab uuid; multi-device overlap is union-merged at read
  state text not null check (state in ('talking', 'dialing', 'between', 'other')),
  surface text,                              -- route prefix the time was spent on
  started_at timestamptz not null,
  ended_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists idx_rai_rep_time on rep_activity_intervals (rep_email, started_at);

alter table rep_activity_intervals enable row level security;

-- Tunable knobs (thresholds + what counts as a calling surface).
create table if not exists rep_activity_config (
  id boolean primary key default true check (id),
  config jsonb not null,
  updated_at timestamptz not null default now()
);
alter table rep_activity_config enable row level security;

insert into rep_activity_config (id, config) values (true, '{
  "idle_ms": 90000,
  "heartbeat_ms": 25000,
  "idle_tail_credit_ms": 30000,
  "kpi_hours": 4,
  "calling_prefixes": ["/dialer", "/lists", "/hot-list", "/crm/deal"]
}'::jsonb)
on conflict (id) do nothing;
