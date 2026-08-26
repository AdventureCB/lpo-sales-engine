-- AI hypothesis ledger — the self-improving outcome loop (Kyle, 8/26).
-- The model proposes broad, FALSIFIABLE pattern claims over all deals
-- (pathways to outcomes); each compiles to a computable predicate over the
-- ai_deal_features snapshot. Lifecycle: proposed → backtested (survives
-- history) → registered (scored ONLY on deals closing after registration —
-- the anti-overfitting gate) → validated / retired. Humans approve
-- ACTIONABILITY, outcomes judge truth. Service-role only.

create table if not exists ai_deal_features (
  deal_id uuid primary key,
  status text,                 -- won | lost (snapshot universe = closed deals)
  closed_at timestamptz,
  features jsonb not null default '{}'::jsonb,
  outcomes jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now()
);
alter table ai_deal_features enable row level security;
create index if not exists idx_ai_deal_features_closed on ai_deal_features (closed_at);

create table if not exists ai_hypotheses (
  id uuid primary key default gen_random_uuid(),
  claim text not null,
  rationale text,
  category text,
  cohort jsonb not null,        -- [{feature, op, value}] — op ∈ eq|neq|gte|lte|in|notnull
  outcome text not null,        -- won | fast_close | replied_48h
  direction text not null default 'higher',  -- cohort rate expected higher|lower than baseline
  status text not null default 'proposed',   -- proposed|backtested|registered|validated|retired|rejected
  backtest jsonb,               -- {cohort_n, cohort_hits, base_n, base_hits, lift, z, at}
  prospective jsonb not null default '{"cohort_n":0,"cohort_hits":0,"base_n":0,"base_hits":0}'::jsonb,
  prospective_z numeric,
  human_approved boolean not null default false,  -- gate for future rep-facing steering
  registered_at timestamptz,
  scored_through timestamptz,   -- closes after this are unscored
  retired_at timestamptz,
  retire_reason text,
  model text,
  created_at timestamptz not null default now()
);
alter table ai_hypotheses enable row level security;
create index if not exists idx_ai_hypotheses_status on ai_hypotheses (status);
