-- Keep crm_deals.last_activity_at live: every new activity or call bumps it
-- immediately (the batch refresh_deal_last_activity() remains for backfills).
create or replace function bump_deal_last_activity()
returns trigger
language plpgsql
as $$
declare
  ts timestamptz := coalesce(new.occurred_at, now());
begin
  if new.deal_id is not null then
    update crm_deals
      set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), ts)
      where id = new.deal_id;
  elsif new.contact_id is not null then
    update crm_deals
      set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), ts)
      where contact_id = new.contact_id;
  end if;
  return new;
end;
$$;

create trigger trg_bump_last_activity
  after insert on crm_activities
  for each row execute function bump_deal_last_activity();

-- Calls land in call_events keyed by the Pipedrive deal id.
create or replace function bump_deal_last_activity_call()
returns trigger
language plpgsql
as $$
begin
  if new.deal_id is not null then
    update crm_deals
      set last_activity_at = greatest(
        coalesce(last_activity_at, '-infinity'::timestamptz),
        coalesce(new.started_at, now())
      )
      where pipedrive_deal_id = new.deal_id;
  end if;
  return new;
end;
$$;

create trigger trg_bump_last_activity_call
  after insert or update of deal_id on call_events
  for each row execute function bump_deal_last_activity_call();
