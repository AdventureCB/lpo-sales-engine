-- Persistent marketing-signal store: Klaviyo events land once and stay;
-- subsequent syncs pull only events newer than the latest stored one.
create table klaviyo_profiles (
  email text primary key,
  profile_id text not null,
  phones jsonb not null default '[]'::jsonb,
  last_synced_at timestamptz,
  updated_at timestamptz not null default now()
);

create table klaviyo_events (
  id text primary key,               -- Klaviyo event id (idempotent ingest)
  profile_id text not null,
  email text not null,
  metric text not null,
  event_at timestamptz not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_klaviyo_events_email on klaviyo_events (email, event_at desc);

alter table klaviyo_profiles enable row level security;
alter table klaviyo_events enable row level security;
