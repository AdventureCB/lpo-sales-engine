-- PD EXIT Phase 0: synthetic deal ids. Native deals (pipedrive_deal_id
-- NULL) were invisible to every numeric-keyed pipeline — engagement
-- matching, hot scoring, hot_flags, call cooldowns. Instead of migrating
-- six consumers to uuids, extend the owner-id precedent (synthetic 900M+
-- internal numbers): EVERY deal now carries a unique internal number in
-- pipedrive_deal_id — real PD ids (≤ ~10k) for mirrored deals, sequence
-- 900,000,001+ for native ones. Post-exit the column is simply "deal
-- number". lib/pipedrive no-ops on synthetic ids so nothing ever tries
-- to write them to Pipedrive during the dual-write window.

create sequence if not exists crm_deal_internal_id start with 900000001;

create or replace function public.assign_internal_deal_id()
returns trigger language plpgsql as $$
begin
  if new.pipedrive_deal_id is null then
    new.pipedrive_deal_id := nextval('crm_deal_internal_id');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assign_internal_deal_id on crm_deals;
create trigger trg_assign_internal_deal_id
  before insert on crm_deals
  for each row execute function public.assign_internal_deal_id();

-- Backfill the existing native deals.
update crm_deals
set pipedrive_deal_id = nextval('crm_deal_internal_id')
where pipedrive_deal_id is null;

-- Engagement matching: with the backfill + trigger, every deal has an
-- internal number, so the "Pipedrive-linked only" condition is vacuously
-- true and native deals now match (RPC body otherwise unchanged from 00080;
-- the is-not-null line stays as a guard).
create or replace function public.match_engagement_to_deals(p_window_start timestamptz, p_limit integer default 6000, p_retry_days integer default 3)
returns integer
language plpgsql
as $function$
declare
  n integer;
begin
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
    update engagement_events e
    set pipedrive_deal_id = ed.pd_id,
        match_attempted_at = now()
    from _todo t
    join _email_deal ed on ed.email = t.email
    where e.id = t.id
    returning e.id
  )
  select count(*) into n from upd;

  update engagement_events e
  set match_attempted_at = now()
  from _todo t
  where e.id = t.id and e.pipedrive_deal_id is null;

  return n;
end;
$function$;
