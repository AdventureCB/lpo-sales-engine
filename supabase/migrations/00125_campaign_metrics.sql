-- Analytics build (Kyle 9/18): per-campaign pages need richer metrics than
-- spend/clicks. Impressions for both channels; Google-only impression-share
-- family (search IS + share lost to budget vs rank), stored as ratios 0-1 per
-- campaign-day. IS is a RATE — never sum it across days; weight by impressions.
alter table ad_campaign_daily add column if not exists impressions bigint;
alter table ad_campaign_daily add column if not exists impr_share numeric;      -- search_impression_share
alter table ad_campaign_daily add column if not exists lost_is_budget numeric;  -- search_budget_lost_impression_share
alter table ad_campaign_daily add column if not exists lost_is_rank numeric;    -- search_rank_lost_impression_share
