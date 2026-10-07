-- Website behavior tracking (attr.js v2). Visitors already get a stable id
-- and are linked to contacts on identify (web_visitor_links); this adds what
-- they DO: page views with active dwell + scroll depth, which sections of a
-- page they actually saw, and named interactions (buttons, links, videos,
-- accordions, forms). Plus Meta's browser cookies per visitor for CAPI later.

create table if not exists web_visitors (
  visitor_id text primary key,
  fbp text,
  fbc text,
  user_agent text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
alter table web_visitors enable row level security;

create table if not exists web_events (
  id bigserial primary key,
  visitor_id text not null,
  session_id text not null,
  at timestamptz not null,
  type text not null check (type in ('pageview','pageend','interaction')),
  path text,
  title text,
  duration_s integer,          -- pageend: active seconds (visible + not idle)
  scroll_pct smallint,         -- pageend: deepest scroll position reached
  sections text[],             -- pageend: headings of sections seen ≥ 2s
  name text,                   -- interaction: click | link | expand | tab | video | form_start | form_submit | outbound | tel | mail
  detail text,                 -- interaction: button text / href / video src / section label …
  referrer text,               -- pageview: external referrer
  created_at timestamptz not null default now()
);
create index if not exists idx_web_events_visitor_at on web_events (visitor_id, at desc);
create index if not exists idx_web_events_at on web_events (at desc);
alter table web_events enable row level security;

alter table web_touches add column if not exists fbp text;
alter table web_touches add column if not exists fbc text;

-- Visitor ids by linked email — the deal page / AI inputs start from contact emails.
create index if not exists idx_web_visitor_links_email on web_visitor_links (lower(email));

-- Sprint-list signal regexes learn the site signal types (applied 10/7 via SQL; recorded here).
update sprint_list_config set config =
  jsonb_set(jsonb_set(config,
    '{hot_1a_regex}', to_jsonb('(cart|checkout|builder_save|save.?build|3d.?build|abandon|booking_click|cart_click)'::text)),
    '{hot_1b_regex}', to_jsonb('(click|viewed_product|active_on_site|form|subscrib|builder|3d|order|financ|video)'::text))
where id = true and config->>'hot_1a_regex' not like '%booking_click%';
