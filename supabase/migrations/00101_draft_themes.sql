-- Draft themes + feedback ledger + style rules + critic proposals.
-- Themes: stable, admin-editable catalog (keys never change → feedback and
-- stats attach to them); the deal context only RANKS them. Style rules: a
-- capped list of durable generation adjustments, critic-proposed and
-- human-approved (same all-approve pattern as taxonomy_proposals).

create table comm_themes (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  intent text,                       -- one-liner shown to reps on the chip
  prompt_direction text not null,    -- steering text injected into generation
  channels text[] not null default '{email,sms}',
  sort_order integer not null default 100,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table comm_themes enable row level security;

insert into comm_themes (key, name, intent, prompt_direction, channels, sort_order) values
  ('quick_nudge', 'Quick nudge', 'Friendly, no-pressure bump for a response',
   'A short, warm bump to get a reply. Reference the last open thread naturally. One light question. Zero pressure, zero re-pitch.',
   '{email,sms}', 10),
  ('build_followup', 'Build & spec follow-up', 'Their saved build / quote specifics',
   'Anchor on their actual build or quote: truck, configuration, accessories. Confirm the specs, tie ONE benefit to their stated use case, invite a review call or a tweak.',
   '{email,sms}', 20),
  ('financing', 'Financing options', '0% APR + Synchrony application path',
   'Lead with affordability: 0% APR financing and the Synchrony application. Frame monthly-payment thinking around their build. One clear step: apply, or ask a question.',
   '{email,sms}', 30),
  ('schedule', 'Get a call booked', 'One clear time ask',
   'Sole goal: a short call on the calendar. Offer two concrete time windows and make saying yes effortless. No selling beyond one line on why the call is worth it.',
   '{email,sms}', 40),
  ('objection', 'Objection follow-up', 'Address the concern that stalled them',
   'Address the specific concern visible in the profile or timeline (price, fitment, timing, spouse buy-in…) head-on. Empathy first, then ONE concrete counterpoint or resource. Do not restate the pitch.',
   '{email,sms}', 50),
  ('recap', 'Post-call recap', 'Confirm what was discussed + the next step',
   'Recap the call''s key points in their words, confirm decisions and specs, and state the single agreed next step with its date. Crisp and scannable.',
   '{email}', 60),
  ('reengage', 'Re-engage cold', 'A new angle after a long silence',
   'It''s been a while — open with something NEW (season, a new accessory, their use case) rather than "just checking in". One fresh hook, one easy question.',
   '{email,sms}', 70),
  ('breakup', 'Breakup', 'Respectful last touch that leaves the door open',
   'A respectful final note: acknowledge the timing may be off, remove all pressure, leave one open door, and make clear you''ll step back. Short and human — this often earns the reply.',
   '{email,sms}', 80);

-- One row per generated draft; updated in place as the rep interacts with it.
create table draft_events (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null,
  kind text not null check (kind in ('email','sms')),
  theme_key text,                    -- null = auto (no theme picked)
  direction text,                    -- rep's freeform steer, if any
  rep text,
  draft_body text,                   -- for edit-similarity vs what was sent
  generated_at timestamptz not null default now(),
  used_at timestamptz,               -- clicked "Use in composer/chat"
  thumbs text check (thumbs in ('up','down')),
  thumbs_note text,
  sent_activity_id uuid,             -- linked at send time (45-min window)
  sent_similarity real               -- 0-1 word overlap draft vs sent
);
create index idx_draft_events_deal on draft_events (deal_id, generated_at desc);
create index idx_draft_events_theme on draft_events (theme_key, generated_at desc);
alter table draft_events enable row level security;

-- Durable generation adjustments (capped ~10 active, enforced in code).
create table draft_style_rules (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'all' check (channel in ('all','email','sms')),
  rule text not null,
  source text not null default 'critic',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table draft_style_rules enable row level security;

-- Critic proposals — same all-approve pattern as taxonomy_proposals.
create table draft_proposals (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  kind text not null check (kind in (
    'theme_edit','theme_add','theme_retire','style_add','style_retire'
  )),
  target_key text,
  current jsonb,
  proposed jsonb not null default '{}'::jsonb,
  rationale text not null,
  evidence text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_draft_proposals_pending on draft_proposals (status, created_at desc);
alter table draft_proposals enable row level security;
