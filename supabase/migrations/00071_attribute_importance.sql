-- Attribute importance (0-3) — weights the AI profiler's data-sufficiency
-- meter. Applied live 8/12; recorded here for reproducibility (idempotent).
alter table profile_attributes add column if not exists importance smallint not null default 1;
