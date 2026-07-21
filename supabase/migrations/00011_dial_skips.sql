-- Session skips: reps can drop a lead from their current dial session
-- (main Skip or from the up-next list); each skip is recorded for reporting.

create table dial_skips (
  id uuid primary key default gen_random_uuid(),
  actor text not null,                  -- app user email
  rep_id uuid references reps (id),
  deal_id bigint not null,
  deal_title text,
  skipped_at timestamptz not null default now()
);

create index idx_dial_skips_deal on dial_skips (deal_id, skipped_at);

alter table dial_skips enable row level security;
