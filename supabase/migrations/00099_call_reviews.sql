-- Call reviews (StoryBrand coaching per call) + per-rep pattern rollups.
-- Reviews live in their own table (not activity meta) so the rep rollup is
-- one indexed query. A review is keyed by EITHER the crm_activities row
-- (Quo-era summaries live in call bodies) or the call_events quo_call_id
-- (Telnyx/Deepgram transcripts in raw->>transcript) — never both.

create table call_reviews (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references crm_deals(id) on delete cascade,
  activity_id uuid references crm_activities(id) on delete cascade,
  quo_call_id text,
  rep text,                                   -- resolved rep display name (null when unknown)
  input_hash text not null,                   -- transcript hash + profile version (re-review gate)
  profile_version integer,
  transcript_chars integer,
  model text,
  review jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (activity_id is not null or quo_call_id is not null)
);

create unique index idx_call_reviews_activity on call_reviews (activity_id) where activity_id is not null;
create unique index idx_call_reviews_call on call_reviews (quo_call_id) where quo_call_id is not null;
create index idx_call_reviews_rep on call_reviews (rep, created_at desc);
create index idx_call_reviews_deal on call_reviews (deal_id);

alter table call_reviews enable row level security;

create table rep_call_patterns (
  rep text primary key,
  review_count integer not null,
  window_days integer not null,
  patterns jsonb not null,
  model text,
  updated_at timestamptz not null default now()
);

alter table rep_call_patterns enable row level security;
