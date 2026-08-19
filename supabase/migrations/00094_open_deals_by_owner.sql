-- User-management panel: open-deal counts per owner (shown as the "reassign
-- these first" hint when deactivating a rep).
create or replace function public.open_deals_by_owner()
returns table(owner_pipedrive_id bigint, n bigint)
language sql
stable
as $$
  select owner_pipedrive_id, count(*)
  from crm_deals
  where status = 'open' and owner_pipedrive_id is not null
  group by 1;
$$;
