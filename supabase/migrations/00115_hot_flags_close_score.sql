-- Hot list v2 seed: nightly-stamped hypothesis-driven close likelihood on
-- active flags (only written while steering is enabled; ordering falls back
-- to flagged_at when null).
alter table hot_flags add column if not exists close_score numeric;
