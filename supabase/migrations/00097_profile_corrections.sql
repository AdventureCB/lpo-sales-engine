-- Phase 5a: rep corrections are PINNED TRUTH the profiler must respect.
-- Shape: { archetypes_wrong: [key], attributes_cleared: [key],
--          tags_removed: [tag], interests_removed: [label],
--          log: [{op, key, by, at}] }
alter table deal_profiles add column if not exists corrections jsonb not null default '{}'::jsonb;
