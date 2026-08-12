-- AI deal-profiler storage (Phase 1 foundation). One evolving profile per
-- deal that ACCUMULATES: each run reconciles the prior read against only the
-- new signals (never re-derives from scratch), which is both cheaper and more
-- accurate. A watermark records what's already been incorporated so the same
-- transcript is never reprocessed; per-attribute confidence lets stable reads
-- stand without re-litigation.

create table if not exists deal_profiles (
  deal_id uuid primary key references crm_deals (id) on delete cascade,
  -- attributes: { key: { value, confidence(0-1), evidence:[...] } }
  attributes jsonb not null default '{}',
  -- archetypes: [ { key, name, pct(0-100), confidence, evidence:[...] } ] desc by pct
  archetypes jsonb not null default '[]',
  summary text,                              -- the inference summary (rep-facing)
  next_action jsonb,                         -- { action, rationale, confidence }
  overall_confidence numeric,                -- 0-1, rises as evidence corroborates
  -- what's already folded in — the "don't rework" watermark
  watermark jsonb not null default '{}',     -- { last_activity_at, seen_activity_ids_hash, touch_cursor, input_hash }
  status text not null default 'pending' check (status in ('pending','fresh','stale','error')),
  last_model text,
  runs int not null default 0,
  version int not null default 1,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table deal_profiles enable row level security;

-- Per-call token/cost ledger — so monthly spend is auditable and the budget
-- is a visible number, not a guess. Also covers non-deal tasks (taxonomy critic).
create table if not exists ai_usage (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid references crm_deals (id) on delete set null,
  task text not null,                        -- extract | revalidate | deepdive | critic
  model text not null,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cache_read_tokens int not null default 0,
  cost_cents numeric(12,5) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_ai_usage_month on ai_usage (created_at);
alter table ai_usage enable row level security;
