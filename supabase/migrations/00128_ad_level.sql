-- Analytics: expand a campaign to its ads (Kyle 9/21). Ad-level daily metrics
-- for both platforms (Meta ad within ad set; Google ad within ad group), plus
-- ad ids on the Google click map so first-party clicks attribute to an AD, not
-- just a campaign. (Meta clicks already carry the ad id in utm_content.)
create table if not exists ad_ad_daily (
  channel text not null,
  campaign_id text not null,
  group_id text,          -- Meta adset_id / Google ad_group.id
  group_name text,
  ad_id text not null,
  name text,
  day date not null,
  spend_cents bigint not null default 0,
  clicks bigint not null default 0,
  impressions bigint not null default 0,
  conv_value_cents bigint,
  conversions numeric,
  updated_at timestamptz not null default now(),
  primary key (channel, ad_id, day)
);
create index if not exists ad_ad_daily_campaign_idx on ad_ad_daily (channel, campaign_id, day);
alter table ad_ad_daily enable row level security;

alter table google_click_map add column if not exists ad_group_id text;
alter table google_click_map add column if not exists ad_id text;
