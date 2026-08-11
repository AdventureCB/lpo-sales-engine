-- Intake Engine: native replacement for the Zapier deal-injection funnels.
-- One engine, many adapters; every funnel is a config row editable in
-- Settings (per-engine round-robin pools with per-rep on/off toggles).
create table if not exists intake_sources (
  id uuid primary key default gen_random_uuid(),
  channel_id integer,                         -- legacy Zapier source-channel id
  label text not null,
  adapter text not null check (adapter in ('shopify_abandoned_checkout', 'typeform', 'klaviyo_metric', 'webhook')),
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table intake_sources enable row level security;

-- Idempotency + audit (reconcile counts against Zapier during migration).
create table if not exists intake_events (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references intake_sources (id) on delete cascade,
  external_id text,
  email text,
  phone text,
  action text not null check (action in ('created', 'noted', 'reopened', 'skipped', 'error')),
  deal_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists uniq_intake_external on intake_events (source_id, external_id) where external_id is not null;
create index if not exists idx_intake_events_time on intake_events (created_at);
alter table intake_events enable row level security;

-- Seed the Abandoned Cart engine (disabled until the Zap is retired).
insert into intake_sources (channel_id, label, adapter, enabled, config)
select 31, 'Abandoned Cart', 'shopify_abandoned_checkout', false, '{
  "sku_contains": "DEPOSIT",
  "delay_minutes": 60,
  "title_template": "Abandoned Cart - {name}",
  "enrich_phone": false,
  "on_existing_open": "note",
  "on_existing_closed": "reopen_assign",
  "source_name": "Abandoned Cart",
  "owner_pool": [
    {"pipedrive_id": 24081760, "name": "Parker", "enabled": true},
    {"pipedrive_id": 24391245, "name": "Jackson", "enabled": true}
  ]
}'::jsonb
where not exists (select 1 from intake_sources where adapter = 'shopify_abandoned_checkout');
