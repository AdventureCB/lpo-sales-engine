-- Maintained per-deal call stats (Kyle 9/23) so the CRM list can FILTER and
-- SORT by contact state and attempt/contact counts across the whole table
-- (the old deals_call_stats RPC only enriched the current page).
-- Definitions follow the Ad ROI lead-contact funnel:
--   attempt = outbound call_events row on the deal (crm_deal_id, or legacy
--             Pipedrive deal_id) + logged crm_activities calls by a rep
--             (type 'call', actor email, NOT scheduled — due_at is null)
--   contact = call_events rep-dispositioned 'connected', or transcript-
--             classified 'conversation' with no contrary disposition
alter table crm_deals
  add column if not exists attempt_count integer not null default 0,
  add column if not exists contact_count integer not null default 0,
  add column if not exists first_attempt_at timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists first_contact_at timestamptz;
create index if not exists idx_crm_deals_attempt_count on crm_deals (attempt_count);
create index if not exists idx_crm_deals_contact_count on crm_deals (contact_count);
create index if not exists idx_call_events_crm_deal on call_events (crm_deal_id);
create index if not exists idx_call_events_pd_deal on call_events (deal_id);

create or replace function public.refresh_deal_call_stats(p_deal uuid)
returns void language plpgsql as $$
declare v_pd bigint;
begin
  select pipedrive_deal_id into v_pd from crm_deals where id = p_deal;
  if not found then return; end if;
  update crm_deals d
  set attempt_count = s.attempts,
      contact_count = s.contacts,
      first_attempt_at = s.first_attempt,
      last_attempt_at = s.last_attempt,
      first_contact_at = s.first_contact
  from (
    with ce as (
      select started_at, direction, disposition, classification
      from call_events
      where crm_deal_id = p_deal or (v_pd is not null and deal_id = v_pd)
    ),
    att as (
      select started_at as at from ce where direction = 'outgoing'
      union all
      select occurred_at from crm_activities
      where deal_id = p_deal and type = 'call' and actor like '%@%' and due_at is null
    ),
    con as (
      select started_at as at from ce
      where disposition = 'connected'
         or (classification = 'conversation' and (disposition is null or disposition = 'connected'))
    )
    select (select count(*) from att)::int as attempts,
           (select min(at) from att) as first_attempt,
           (select max(at) from att) as last_attempt,
           (select count(*) from con)::int as contacts,
           (select min(at) from con) as first_contact
  ) s
  where d.id = p_deal
    and (d.attempt_count, d.contact_count, d.first_attempt_at, d.last_attempt_at, d.first_contact_at)
        is distinct from (s.attempts, s.contacts, s.first_attempt, s.last_attempt, s.first_contact);
end $$;

-- call_events: any insert, or a change to the fields the stats read.
create or replace function public.trg_deal_call_stats_ce()
returns trigger language plpgsql as $$
declare v_new uuid; v_old uuid;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := coalesce(new.crm_deal_id, (select id from crm_deals where new.deal_id is not null and pipedrive_deal_id = new.deal_id limit 1));
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := coalesce(old.crm_deal_id, (select id from crm_deals where old.deal_id is not null and pipedrive_deal_id = old.deal_id limit 1));
  end if;
  if v_new is not null then perform refresh_deal_call_stats(v_new); end if;
  if v_old is not null and v_old is distinct from v_new then perform refresh_deal_call_stats(v_old); end if;
  return null;
end $$;
drop trigger if exists trg_deal_call_stats_ce on call_events;
create trigger trg_deal_call_stats_ce
  after insert or delete or update of crm_deal_id, deal_id, direction, disposition, classification on call_events
  for each row execute function trg_deal_call_stats_ce();

-- crm_activities: logged calls (type 'call').
create or replace function public.trg_deal_call_stats_act()
returns trigger language plpgsql as $$
begin
  if tg_op in ('INSERT', 'UPDATE') and new.type = 'call' and new.deal_id is not null then perform refresh_deal_call_stats(new.deal_id); end if;
  if tg_op in ('UPDATE', 'DELETE') and old.type = 'call' and old.deal_id is not null and (tg_op = 'DELETE' or old.deal_id is distinct from new.deal_id) then perform refresh_deal_call_stats(old.deal_id); end if;
  return null;
end $$;
drop trigger if exists trg_deal_call_stats_act on crm_activities;
create trigger trg_deal_call_stats_act
  after insert or delete or update of type, deal_id, due_at, actor, occurred_at on crm_activities
  for each row execute function trg_deal_call_stats_act();

-- Backfill every deal once.
select count(*) from (select refresh_deal_call_stats(id) from crm_deals) x;
