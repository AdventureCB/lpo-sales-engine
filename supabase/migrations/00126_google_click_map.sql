-- Phase 2 (Kyle 9/18): per-campaign ROAS. First-party Google clicks carry a
-- gclid but often an unusable utm_campaign, so we resolve gclid → campaign via
-- the Google Ads click_view report and store it here. Deal attribution then maps
-- a contact's Google click to a real campaign for revenue/ROAS. (Facebook clicks
-- already carry the campaign id in web_touches.campaign — no map needed there.)
create table if not exists google_click_map (
  gclid text primary key,
  campaign_id text,
  day date,
  updated_at timestamptz not null default now()
);
create index if not exists google_click_map_campaign_idx on google_click_map (campaign_id);
