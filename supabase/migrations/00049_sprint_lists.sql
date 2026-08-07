-- Sprint Lists (Phase A): daily auto-generated call lists riding the existing
-- sprint rail. crm_sprints/_items become "typed lists"; the dialer already
-- surfaces active sprints as queues, so daily lists inherit dialing for free.
-- All generation reads the CRM mirror only — zero Pipedrive calls.

-- ── Typed lists on the sprint table ────────────────────────────────────────
alter table crm_sprints
  add column if not exists kind text not null default 'manual'
    check (kind in ('manual', 'daily', 'filter', 'assigned')),
  add column if not exists slot smallint,             -- 1|2|3 for daily lists
  add column if not exists for_date date,             -- target day for a daily list
  add column if not exists cap integer,               -- max deals (null = uncapped)
  add column if not exists filter_json jsonb,         -- saved dynamic filter (filter kind)
  add column if not exists generated_at timestamptz,
  add column if not exists meta jsonb not null default '{}'::jsonb;

-- One daily list per (owner, slot, date) — regeneration replaces in place.
create unique index if not exists uniq_daily_list
  on crm_sprints (owner, slot, for_date)
  where kind = 'daily';

-- ── Per-item ranking provenance ────────────────────────────────────────────
alter table crm_sprint_items
  add column if not exists tier smallint,             -- ladder rung 1..6
  add column if not exists tier_label text,           -- '1a','1b','2'… for display
  add column if not exists source text,               -- ladder|carryover|stale|reprospect|manual
  add column if not exists tz_bucket text,            -- east|central|west
  add column if not exists added_manually boolean not null default false,
  add column if not exists removed_at timestamptz;    -- rep pruned it from today's list

-- ── Reprospecting checkout: exclusive 3-day hold on a Cainen-pool deal ──────
create table if not exists crm_reprospect_checkouts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references crm_deals (id) on delete cascade,
  rep_email text not null,
  checked_out_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  release_reason text
    check (release_reason in ('expired', 'conversation', 'lost', 'scheduled', 'manual')),
  created_at timestamptz not null default now()
);

-- The exclusivity guarantee: at most one active checkout per deal, DB-enforced.
create unique index if not exists uniq_active_reprospect
  on crm_reprospect_checkouts (deal_id)
  where released_at is null;
create index if not exists idx_reprospect_rep
  on crm_reprospect_checkouts (rep_email)
  where released_at is null;

alter table crm_reprospect_checkouts enable row level security;

-- ── Tunable config (single row) ────────────────────────────────────────────
create table if not exists sprint_list_config (
  id boolean primary key default true check (id),
  config jsonb not null,
  updated_at timestamptz not null default now()
);
alter table sprint_list_config enable row level security;

insert into sprint_list_config (id, config) values (true, '{
  "cap": 60,
  "reprospect_subcap": null,
  "checkout_hold_days": 3,
  "windows": {
    "hot_days": 7,
    "new_deal_days": 14,
    "marketing_signal_days": 14,
    "recent_activity_days": 7,
    "scheduled_ahead_days": 7,
    "no_conversation_days": 60,
    "stale_min_days": 60,
    "stale_max_days": 90,
    "cap_fill_no_activity_days": 60
  },
  "hot_1a_regex": "(add.*cart|checkout started|started checkout|save.*build|3d builder)",
  "clock": { "list1": "09:00", "list2": "12:00", "list3": "13:00" },
  "cainen_owner_pipedrive_id": null
}'::jsonb)
on conflict (id) do nothing;
