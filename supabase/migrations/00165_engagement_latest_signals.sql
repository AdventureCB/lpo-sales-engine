-- Sprint-list reprospect pool: latest marketing signal (and latest HOT
-- signal) per email. The generator used to page the whole engagement_events
-- table through PostgREST (1M rows after the Klaviyo backfills → 1,000
-- requests → Vercel 60s timeout, "List 1 won't generate"). One aggregate
-- instead. The regex is matched against the ~10 distinct event types, not
-- per row (per-row ~* took 12s; this is ~2s).
create or replace function engagement_latest_signals(p_hot_regex text)
returns table (email text, latest timestamptz, latest_hot timestamptz)
language sql stable security definer set search_path = public as $$
  with hot_types as (
    select distinct type from engagement_events where type ~* p_hot_regex
  )
  select lower(person_email) as email,
         max(occurred_at) as latest,
         max(occurred_at) filter (where type in (select type from hot_types)) as latest_hot
  from engagement_events
  where person_email is not null and person_email <> ''
  group by 1;
$$;
