-- Drip campaigns, Phase 0 (Kyle 9/24). One engine, two authoring modes:
-- 'macro' (hand-written steps) and 'ai' (per-step prompt, Phase 2). Every
-- send is a queue item a human approves. Sends go from the DEAL OWNER's own
-- Gmail / Telnyx number and land on the timeline like any other email/text.
--
-- Rules (Kyle 9/24): approver = deal owner or admin; caps 2 email + 2 text
-- per contact per 7 days (campaign sends only); owner's own manual send →
-- next step waits ≥24h; a DIFFERENT rep's send → campaign stops; one active
-- campaign per deal per channel; opt-out works (reply keywords, DNC, unlinked
-- /u/<token>) but is never shown in the email.

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  channel text not null default 'email' check (channel in ('email', 'sms')),
  mode text not null default 'macro' check (mode in ('macro', 'ai')),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  owner_email text,                                  -- creator; reps see their own + admins' shared ones
  shared boolean not null default true,              -- visible/enrollable by every rep
  trigger jsonb not null default '{"type":"manual"}'::jsonb,
  settings jsonb not null default '{}'::jsonb,       -- {window_start, window_end, exit_on_reply, ...}
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table campaigns enable row level security;

create table if not exists campaign_steps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  position integer not null default 0,
  delay_hours integer not null default 48,           -- after enrollment (step 1) / after the previous send
  content_kind text not null default 'inline' check (content_kind in ('inline', 'macro', 'prompt')),
  macro_id uuid references comm_macros(id) on delete set null,
  subject text,
  body text,                                          -- plain text with {{placeholders}}
  prompt text,                                        -- ai mode (Phase 2)
  steering text,
  conditions jsonb not null default '{}'::jsonb,      -- {skip_if_opened_prev, only_if_opened_prev}
  created_at timestamptz not null default now()
);
create index if not exists idx_campaign_steps_campaign on campaign_steps (campaign_id, position);
alter table campaign_steps enable row level security;

create table if not exists campaign_enrollments (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  deal_id uuid not null references crm_deals(id) on delete cascade,
  contact_id uuid references crm_contacts(id) on delete set null,
  owner_email text,                                   -- deal owner at enrollment = sender + approver
  status text not null default 'active' check (status in ('active', 'exited', 'completed')),
  current_step integer not null default 0,           -- steps sent so far
  next_step_at timestamptz,                           -- when the next step is due (pre-window)
  last_send_at timestamptz,
  hold_reason text,                                   -- why the next step is waiting (informational)
  enrolled_at timestamptz not null default now(),
  enrolled_by text,
  exited_at timestamptz,
  exit_reason text,
  unique (campaign_id, deal_id)
);
create index if not exists idx_campaign_enrollments_due on campaign_enrollments (status, next_step_at);
create index if not exists idx_campaign_enrollments_deal on campaign_enrollments (deal_id);
alter table campaign_enrollments enable row level security;

create table if not exists campaign_sends (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references campaign_enrollments(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  step_id uuid references campaign_steps(id) on delete set null,
  step_position integer not null default 0,
  deal_id uuid not null,
  contact_id uuid,
  owner_email text,                                   -- sender + default approver
  channel text not null default 'email',
  to_address text,
  subject text,
  body text,                                          -- plain text as it will send
  generated_by text not null default 'macro',        -- 'macro' | 'ai'
  ai_meta jsonb,                                      -- model, rationale, variant (Phase 2)
  status text not null default 'draft' check (status in ('draft', 'approved', 'sent', 'skipped', 'rejected', 'failed')),
  scheduled_for timestamptz,
  approved_by text,
  approved_at timestamptz,
  edited boolean not null default false,
  original_body text,                                 -- pre-edit body (learning signal)
  sent_at timestamptz,
  activity_id uuid,
  track_token uuid,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists idx_campaign_sends_queue on campaign_sends (status, scheduled_for);
create index if not exists idx_campaign_sends_owner on campaign_sends (owner_email, status);
create index if not exists idx_campaign_sends_contact_week on campaign_sends (contact_id, channel, sent_at);
alter table campaign_sends enable row level security;

-- Opt-out state (never shown in emails; honored everywhere).
alter table crm_contacts add column if not exists email_unsub boolean not null default false;
alter table crm_contacts add column if not exists email_unsub_at timestamptz;
alter table crm_contacts add column if not exists email_unsub_source text;
