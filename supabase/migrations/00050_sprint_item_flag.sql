-- A per-item flag surfaced to the rep (e.g. a buy-signal override that beats
-- future-scheduled suppression on the daily Sprint Lists).
alter table crm_sprint_items add column if not exists flag text;
