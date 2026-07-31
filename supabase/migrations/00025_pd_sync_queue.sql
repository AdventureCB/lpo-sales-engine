-- Durable Pipedrive outbox: CRM writes land natively first, then sync to
-- Pipedrive as API budget allows (drained by cron + manual trigger; halts
-- cleanly on the daily rate limit and resumes later).
create table pd_sync_queue (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'error')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index idx_pd_sync_pending on pd_sync_queue (status, created_at);
alter table pd_sync_queue enable row level security;
