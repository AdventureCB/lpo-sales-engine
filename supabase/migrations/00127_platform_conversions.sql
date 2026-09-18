-- Deploy B (Kyle 9/18): "channel-reported ROAS" — the ad platforms' OWN reported
-- conversion value/count (Google conversions_value, Meta purchase action_values),
-- stored per campaign-day beside spend. Platform ROAS = conv_value ÷ spend; shown
-- next to our first-party CRM-attributed ROAS so the gap between what the platform
-- claims and what actually became won revenue is visible.
alter table ad_campaign_daily add column if not exists conv_value_cents bigint;
alter table ad_campaign_daily add column if not exists conversions numeric;
