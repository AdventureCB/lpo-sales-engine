-- Make hot-list signal→deal matching CRM-native. The old path linked each
-- unmatched engagement_event to a deal via LIVE Pipedrive (findPersonIdByEmail
-- + getOpenDealsForPerson), hard-capped at 25 emails/sweep by the Pipedrive
-- budget diet — so ~86% of signals never attached to a deal and never scored.
--
-- This does the match entirely in Postgres against the CRM mirror, using the
-- case-insensitive email GIN index (contact_email_set, migration 00065). No
-- Pipedrive calls, no per-email round-trips, no cap.

create or replace function public.match_engagement_to_deals(
  p_window_start timestamptz,
  p_limit int default 6000,
  p_retry_days int default 3
) returns integer
language plpgsql
as $$
declare
  n integer;
begin
  -- Unmatched signals in the scoring window, freshest first. Re-attempt stale
  -- ones after p_retry_days so a deal created AFTER its signal still links;
  -- brand-new rows (match_attempted_at null) are tried immediately.
  create temp table _todo on commit drop as
    select id, lower(person_email) as email
    from engagement_events
    where pipedrive_deal_id is null
      and person_email is not null
      and occurred_at >= p_window_start
      and (match_attempted_at is null
           or match_attempted_at < now() - make_interval(days => p_retry_days))
    order by occurred_at desc
    limit p_limit;

  -- Best open, Pipedrive-linked deal per distinct email (most recent activity
  -- wins). The @> against contact_email_set uses the GIN index.
  create temp table _email_deal on commit drop as
    select em.email, dd.pd_id
    from (select distinct email from _todo) em
    join lateral (
      select d.pipedrive_deal_id as pd_id
      from crm_contacts c
      join crm_deals d on d.contact_id = c.id
      where d.status = 'open'
        and d.pipedrive_deal_id is not null
        and public.contact_email_set(c.emails) @> array[em.email]
      order by d.last_activity_at desc nulls last
      limit 1
    ) dd on true;

  with upd as (
    update engagement_events ev
    set pipedrive_deal_id = ed.pd_id,
        match_attempted_at = now()
    from _todo t
    join _email_deal ed on ed.email = t.email
    where ev.id = t.id
    returning 1
  )
  select count(*) into n from upd;

  -- Mark the leftovers attempted so they wait out the retry window instead of
  -- being re-scanned every sweep.
  update engagement_events ev
  set match_attempted_at = now()
  from _todo t
  where ev.id = t.id and ev.pipedrive_deal_id is null;

  return n;
end
$$;
