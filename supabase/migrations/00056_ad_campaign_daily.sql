-- Campaign-level daily ad performance (direct platform APIs; Meta first,
-- Google when its dev token clears). Powers campaign NAME resolution and
-- per-campaign CPC pricing of ad interactions.
create table if not exists ad_campaign_daily (
  channel text not null,
  campaign_id text not null,
  day date not null,
  name text,
  spend_cents integer not null default 0,
  clicks integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (channel, campaign_id, day)
);
create index if not exists idx_acd_campaign on ad_campaign_daily (channel, campaign_id);
alter table ad_campaign_daily enable row level security;
