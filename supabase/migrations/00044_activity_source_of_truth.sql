-- Make crm_activities the source of truth for last_activity_at (no longer
-- mirrored from Pipedrive). The bump trigger must fire on completion too
-- (marking an activity done is an UPDATE), and use the done time.
create or replace function bump_deal_last_activity() returns trigger
language plpgsql as $$
declare
  ts timestamptz := greatest(
    coalesce(new.occurred_at, now()),
    coalesce(new.done_at, '-infinity'::timestamptz)
  );
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

drop trigger if exists trg_bump_last_activity on crm_activities;
create trigger trg_bump_last_activity
  after insert or update of occurred_at, done_at, deal_id, contact_id on crm_activities
  for each row execute function bump_deal_last_activity();

-- Recompute cleanly (max of when things happened / were completed) — the
-- canonical baseline the triggers then keep fresh.
create or replace function refresh_deal_last_activity() returns void
language sql security definer as $$
  with touches as (
    select deal_id as id, max(greatest(occurred_at, coalesce(done_at, occurred_at))) as m
    from crm_activities where deal_id is not null group by deal_id
    union all
    select d.id, max(greatest(a.occurred_at, coalesce(a.done_at, a.occurred_at)))
    from crm_activities a join crm_deals d on d.contact_id = a.contact_id
    where a.contact_id is not null group by d.id
    union all
    select d.id, max(c.started_at)
    from call_events c join crm_deals d on d.pipedrive_deal_id = c.deal_id
    where c.deal_id is not null group by d.id
  ),
  last as (select id, max(m) as max_at from touches group by id)
  update crm_deals set last_activity_at = last.max_at
  from last
  where crm_deals.id = last.id
    and crm_deals.last_activity_at is distinct from last.max_at;
$$;
