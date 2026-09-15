-- Reviews can stay visible to the rep but be excluded from the leaderboard/KPI
-- (Kyle 9/15): the 3-min / lost-10-min policy, plus admin manual exclusions.
alter table call_reviews add column if not exists excluded_from_score boolean not null default false;
alter table call_reviews add column if not exists excluded_by text;

update call_reviews cr
set excluded_from_score = true, excluded_by = 'auto'
from call_events ce
where ce.quo_call_id = cr.quo_call_id
  and cr.excluded_from_score = false
  and (
    ce.duration_s < 180
    or (ce.duration_s < 600 and exists (select 1 from crm_deals d where d.id = cr.deal_id and d.status = 'lost'))
  );
