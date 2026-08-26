-- Native deals have no pd_add_time, so the CRM list's Created column showed
-- blank and "Newest/Oldest deals" sorting mis-ordered them. Backfill from
-- created_at and let the 00112 trigger stamp it for future native deals
-- (column defaults are applied before BEFORE-ROW triggers, so created_at is
-- populated by the time we read it).

update crm_deals set pd_add_time = created_at where pd_add_time is null;

create or replace function public.assign_internal_deal_id()
returns trigger language plpgsql as $$
begin
  if new.pipedrive_deal_id is null then
    new.pipedrive_deal_id := nextval('crm_deal_internal_id');
  end if;
  if new.pd_add_time is null then
    new.pd_add_time := coalesce(new.created_at, now());
  end if;
  return new;
end;
$$;
