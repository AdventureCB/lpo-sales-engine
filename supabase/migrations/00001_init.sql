-- LPO Sales Engine — initial schema (Phase 0)
-- Standalone Supabase project. Money is stored as integer cents throughout.

create extension if not exists pgcrypto;

-- ── Reps & attribution registry ─────────────────────────────────────────────

create table reps (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique,
  quo_user_id text unique,
  pipedrive_user_id bigint unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Registry-first attribution: known discount codes map to reps here; the
-- first-name-prefix match (PARKER…, JACKSON…) is only the fallback.
create table rep_codes (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references reps(id),
  code text not null unique,
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now()
);

-- ── Commission engine (Module 3) ────────────────────────────────────────────

create table sales_journeys (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid references reps(id),
  code_rep_id uuid references reps(id),        -- attribution via discount code
  deal_owner_rep_id uuid references reps(id),  -- cross-check via Pipedrive owner
  pipedrive_deal_id bigint,
  state text not null default 'deposit_only'
    check (state in ('deposit_only','confirmed','walk_in','paid','clawed_back','expired')),
  is_conflict boolean not null default false,
  deposit_started_at timestamptz,
  confirmed_at timestamptz,
  expires_at timestamptz,
  eligible_total_cents integer not null default 0,
  commission_amount_cents integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sales_orders (
  id uuid primary key default gen_random_uuid(),
  shopify_order_id bigint not null unique,     -- idempotent webhook ingestion
  order_number text,
  customer_email text,
  customer_shopify_id bigint,
  customer_name_norm text,
  customer_phone text,
  subtotal_cents integer,
  eligible_subtotal_cents integer,             -- after excluded types; Phase 4
  discount_codes jsonb not null default '[]'::jsonb,
  classification text
    check (classification in ('deposit','confirmation','walk_in','other')),
  journey_id uuid references sales_journeys(id),
  is_manual boolean not null default false,
  added_by text,
  order_created_at timestamptz,
  raw jsonb,                                   -- full payload; refunds recompute from here
  created_at timestamptz not null default now()
);

create index idx_sales_orders_email on sales_orders (customer_email);
create index idx_sales_orders_journey on sales_orders (journey_id);
create index idx_journeys_state on sales_journeys (state);
create index idx_journeys_deal on sales_journeys (pipedrive_deal_id);

create table payroll_statements (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references reps(id),
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft','approved','exported')),
  approved_by text,
  exported_at timestamptz,
  created_at timestamptz not null default now(),
  unique (rep_id, period_start, period_end)
);

create table statement_lines (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references payroll_statements(id),
  journey_id uuid not null references sales_journeys(id),
  amount_cents integer not null,               -- clawbacks are negative lines
  created_at timestamptz not null default now()
);

-- ── Call tracking (Modules 1 & 3) ───────────────────────────────────────────

create table call_events (
  id uuid primary key default gen_random_uuid(),
  quo_call_id text not null unique,            -- idempotent webhook ingestion
  rep_id uuid references reps(id),
  direction text check (direction in ('incoming','outgoing')),
  status text,
  started_at timestamptz,
  answered_at timestamptz,
  completed_at timestamptz,
  duration_s integer,
  classification text
    check (classification in ('conversation','voicemail','no_answer','screening')),
  disposition text
    check (disposition in ('connected','vm_dropped','bad_number','callback')),
  deal_id bigint,                              -- Pipedrive deal, when known
  raw jsonb,                                   -- webhook payload; NEVER transcript text
  created_at timestamptz not null default now()
);

create index idx_call_events_rep_day on call_events (rep_id, started_at);

-- ── Hot list (Module 2) ─────────────────────────────────────────────────────

create table engagement_events (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('klaviyo','pipedrive','shopify','quo')),
  type text not null,
  person_email text,
  pipedrive_deal_id bigint,
  occurred_at timestamptz not null,
  meta jsonb,
  created_at timestamptz not null default now(),
  -- dedupe key for repeated 15-min sweeps over the same window
  unique (source, type, person_email, occurred_at)
);

create index idx_engagement_deal on engagement_events (pipedrive_deal_id, occurred_at);
create index idx_engagement_email on engagement_events (person_email, occurred_at);

create table hot_flags (
  id uuid primary key default gen_random_uuid(),
  deal_id bigint not null,
  reason text not null,
  flagged_at timestamptz not null default now(),
  cleared_at timestamptz,
  cooldown_until timestamptz
);

create index idx_hot_flags_deal on hot_flags (deal_id, flagged_at);

-- ── Config ──────────────────────────────────────────────────────────────────

create table queue_config (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  stage_ids int[] not null,
  priority integer not null,                   -- 1 = worked first
  cadence_days integer not null,
  is_primary boolean not null default false
);

-- Single-row app config: thresholds are config, not code.
create table app_config (
  id boolean primary key default true check (id),
  deposit_amount_cents integer not null default 50000,
  deposit_tolerance_cents integer not null default 1,     -- ≈ $500 ± 1¢
  confirmation_threshold_cents integer not null default 500000,
  pairing_window_days integer not null default 180,
  commission_flat_cents integer not null default 10000,
  excluded_product_types text[] not null default '{Merch}',
  hot_rules jsonb not null default '{
    "opens_in_window": 3, "opens_window_days": 7,
    "click_window_hours": 72,
    "distinct_signal_types": 2, "distinct_signal_window_hours": 72,
    "cooldown_days": 7, "quiet_clear_days": 7
  }'::jsonb,
  dnc_start_hour integer not null default 9,   -- lead-local, inferred from area code
  dnc_end_hour integer not null default 19,
  max_attempts_per_week integer,               -- guard exists in spec; number TBD with Kyle
  timezone text not null default 'America/Los_Angeles'
);

create table admin_corrections (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  action text not null,
  target text not null,
  reason text not null,                        -- every override requires a reason
  created_at timestamptz not null default now()
);

-- ── Row-level security ──────────────────────────────────────────────────────
-- Service-role (webhooks/cron/API routes) bypasses RLS; nothing else gets in
-- until rep/admin policies land with the dashboard auth phase.

alter table reps enable row level security;
alter table rep_codes enable row level security;
alter table sales_orders enable row level security;
alter table sales_journeys enable row level security;
alter table payroll_statements enable row level security;
alter table statement_lines enable row level security;
alter table call_events enable row level security;
alter table engagement_events enable row level security;
alter table hot_flags enable row level security;
alter table queue_config enable row level security;
alter table app_config enable row level security;
alter table admin_corrections enable row level security;

-- ── Seed data (known constants from live systems — editable, not code) ──────

insert into app_config default values;

insert into reps (name, email, quo_user_id, active) values
  ('Parker Kiesz',   'parker@lonepeakoverland.com',  'USlRvDLVOp', true),
  ('Jackson Faerber', 'jackson@lonepeakoverland.com', 'USSvY8hkeK', true);
-- Other Quo workspace users (Briar USkRGQ5lOo, Gabi USk5E8eUGe, Kecia USNLigZ9Gn)
-- are not dialer reps; add rows here if they ever take commissionable sales.

-- Pipedrive stage → queue mapping (pipelines: 6 Intake, 7 Sales/Nurture, 8 Order).
-- Not queued: Waiting on Timing 47, Confirmation Scheduled 52, Confirmed 53.
insert into queue_config (name, stage_ids, priority, cadence_days, is_primary) values
  ('Intake / first touch',        '{44}',    1, 1, true),
  ('Deposit → paid-in-full push', '{50,51}', 2, 1, false),
  ('Hot follow-up',               '{56}',    3, 1, false),
  ('Warm follow-up',              '{55,48}', 4, 3, false),
  ('Cold / long nurture',         '{54,46}', 5, 7, false),
  ('Recovery',                    '{45}',    6, 7, false);

-- rep_codes starts empty on purpose: it registers EXACT known discount codes
-- (registry-first); first-name-prefix matching is the runtime fallback for
-- codes not yet registered. Seeding guessed codes would defeat the registry.
