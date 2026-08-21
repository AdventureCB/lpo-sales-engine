-- Dialer micro-timings (engagement dashboard): one row per dial cycle,
-- posted when the rep advances. view_ms = lead painted → first dial press;
-- wrap_ms = call end → Next press (disposition + review time). Port-agnostic:
-- measured client-side around the Dial/Next gestures.

create table dialer_cycle_stats (
  id uuid primary key default gen_random_uuid(),
  rep_email text not null,
  crm_deal_id uuid,
  view_ms integer,
  wrap_ms integer,
  at timestamptz not null default now()
);
create index idx_dcs_rep_at on dialer_cycle_stats (rep_email, at desc);

alter table dialer_cycle_stats enable row level security;
