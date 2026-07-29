-- CRM core (Phase CRM-0): our own system of record, admin-only for now.
-- Pipedrive mirrors INTO these tables (pipedrive_* ids kept for sync);
-- everything is designed for native use after cutover, not as a clone.

create table crm_contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  first_name text,
  last_name text,
  emails jsonb not null default '[]'::jsonb,   -- [{value, primary}]
  phones jsonb not null default '[]'::jsonb,   -- [{value, primary, label}]
  org_name text,
  source text,
  custom jsonb not null default '{}'::jsonb,
  pipedrive_person_id bigint unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_crm_contacts_name on crm_contacts using gin (to_tsvector('simple', name));

create table crm_pipelines (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order integer not null default 0,
  pipedrive_pipeline_id bigint unique
);

create table crm_stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references crm_pipelines (id),
  name text not null,
  sort_order integer not null default 0,
  pipedrive_stage_id bigint unique
);

create table crm_deals (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  contact_id uuid references crm_contacts (id),
  stage_id uuid references crm_stages (id),
  status text not null default 'open' check (status in ('open', 'won', 'lost')),
  value_cents integer,
  owner_email text,                            -- app_users.email after cutover
  owner_pipedrive_id bigint,
  label text,
  source text,
  custom jsonb not null default '{}'::jsonb,
  stage_changed_at timestamptz,
  won_at timestamptz,
  lost_at timestamptz,
  lost_reason text,
  pipedrive_deal_id bigint unique,
  pd_add_time timestamptz,                     -- original creation in Pipedrive
  last_activity_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_crm_deals_stage on crm_deals (stage_id, status);
create index idx_crm_deals_owner on crm_deals (owner_pipedrive_id, status);
create index idx_crm_deals_title on crm_deals using gin (to_tsvector('simple', title));

create table crm_activities (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid references crm_deals (id),
  contact_id uuid references crm_contacts (id),
  type text not null check (type in ('call', 'sms', 'email', 'task', 'note', 'meeting', 'system')),
  subject text,
  body text,
  actor text,                                  -- who did/owns it (email)
  due_at timestamptz,
  done_at timestamptz,
  meta jsonb not null default '{}'::jsonb,     -- quo_call_id, disposition, etc.
  pipedrive_activity_id bigint unique,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index idx_crm_activities_deal on crm_activities (deal_id, occurred_at desc);

-- Sprint lists: a named batch of deals a rep queues up for a dial session.
create table crm_sprints (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner text not null,                         -- app user email
  status text not null default 'active' check (status in ('active', 'done', 'archived')),
  created_at timestamptz not null default now()
);

create table crm_sprint_items (
  sprint_id uuid not null references crm_sprints (id) on delete cascade,
  deal_id uuid not null references crm_deals (id) on delete cascade,
  position integer not null default 0,
  called_at timestamptz,
  disposition text,
  primary key (sprint_id, deal_id)
);

-- Automation definitions (engine ships in CRM-2; table now so the model is
-- stable): trigger/conditions/actions as data, not code.
create table crm_automations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  enabled boolean not null default false,
  trigger jsonb not null,                      -- {type: 'stage_changed', ...}
  conditions jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,  -- [{type: 'send_email', ...}]
  created_by text not null,
  created_at timestamptz not null default now()
);

create table crm_automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references crm_automations (id),
  deal_id uuid,
  status text not null,                        -- ok | error | skipped
  detail jsonb,
  ran_at timestamptz not null default now()
);

-- Sync bookkeeping (import cursors, webhook watermarks).
create table crm_sync_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table crm_contacts enable row level security;
alter table crm_pipelines enable row level security;
alter table crm_stages enable row level security;
alter table crm_deals enable row level security;
alter table crm_activities enable row level security;
alter table crm_sprints enable row level security;
alter table crm_sprint_items enable row level security;
alter table crm_automations enable row level security;
alter table crm_automation_runs enable row level security;
alter table crm_sync_state enable row level security;
