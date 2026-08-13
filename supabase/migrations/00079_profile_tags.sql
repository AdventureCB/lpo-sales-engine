-- Free-form specific tags on a deal profile (surfing, has two dogs, tows a
-- boat …) — the memorable specifics that don't fit the fixed attributes.
alter table deal_profiles add column if not exists tags text[] not null default '{}';
