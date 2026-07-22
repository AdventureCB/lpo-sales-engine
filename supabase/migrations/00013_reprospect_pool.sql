-- Re-Prospect Pool (Pipedrive pipeline 10): a shared calling pool worked by
-- multiple reps at once. Attempts put a deal on a 2-day cooldown; leases
-- stop two reps from getting the same deal in their queues simultaneously;
-- fewest-attempts-first ordering means nobody gets a second call until the
-- whole pool has had its first.

create table dial_attempts (
  id uuid primary key default gen_random_uuid(),
  deal_id bigint not null,
  actor text not null,                    -- app user email
  rep_id uuid references reps (id),
  attempted_at timestamptz not null default now()
);

create index idx_dial_attempts_deal on dial_attempts (deal_id, attempted_at desc);

create table dial_leases (
  deal_id bigint primary key,
  actor text not null,
  leased_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table queue_config add column pool_mode boolean not null default false;

insert into queue_config (name, stage_ids, priority, cadence_days, is_primary, pool_mode)
values ('Re-Prospect Pool', '{62}', 7, 2, false, true);

alter table dial_attempts enable row level security;
alter table dial_leases enable row level security;
