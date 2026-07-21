-- Most Klaviyo signals belong to marketing recipients with no Pipedrive
-- person; remember when we last tried to match each event so sweeps don't
-- re-search the same emails and trip Pipedrive's rate limit.

alter table engagement_events add column match_attempted_at timestamptz;

create index idx_engagement_unmatched
  on engagement_events (occurred_at)
  where pipedrive_deal_id is null;
