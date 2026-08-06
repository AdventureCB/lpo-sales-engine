-- Primary interests per deal (camping, hunting, mtb, surfing…). CRM-native
-- (no Pipedrive field). Array + GIN index for overlap filtering.
alter table crm_deals add column interests text[] not null default '{}';
create index idx_crm_deals_interests on crm_deals using gin (interests);

-- Distinct vehicle makes (prefix of truck_model before " - ") for the filter.
create or replace function vehicle_makes()
returns table(make text, n bigint)
language sql stable as $$
  select split_part(truck_model, ' - ', 1) as make, count(*)
  from crm_deals
  where truck_model is not null and truck_model <> ''
  group by 1
  order by 2 desc
$$;
