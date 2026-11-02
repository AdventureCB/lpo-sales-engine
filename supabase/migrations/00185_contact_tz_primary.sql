-- Contact timezone follows the PRIMARY phone (ClickUp 86bcfm553, Cainen 11/2).
-- contact_tz_offset read array slot 0 and ignored primary/bad, so starring a
-- different number (now possible from the dialer) never moved tz_offset.
-- Order: non-bad primary → non-bad by position → any number by position
-- (keeps tz populated for all-bad contacts). Trigger trg_contact_tz unchanged.
-- Snapshot table crm_contacts_tz_backup_00185 = restore point + audit.
create table if not exists crm_contacts_tz_backup_00185 (
  id uuid primary key,
  tz_offset_before smallint,
  tz_offset_after smallint,
  taken_at timestamptz not null default now()
);
alter table crm_contacts_tz_backup_00185 enable row level security;
insert into crm_contacts_tz_backup_00185 (id, tz_offset_before)
select id, tz_offset from crm_contacts
on conflict (id) do nothing;
create or replace function contact_tz_offset(p_phones jsonb) returns smallint
language sql stable as $$
  with picked as (
    select coalesce(e->>'e164', e->>'value', '') as raw
    from jsonb_array_elements(coalesce(p_phones, '[]'::jsonb)) with ordinality as t(e, ord)
    order by
      coalesce((e->>'primary')::boolean, false) desc,
      coalesce((e->>'bad')::boolean, false) asc,
      ord
    limit 1
  ),
  d as (select regexp_replace(raw, '\D', '', 'g') as num from picked)
  select a.utc_offset
  from d
  join area_code_tz a
    on a.code = case
      when length(d.num) = 11 and left(d.num, 1) = '1' then substr(d.num, 2, 3)
      when length(d.num) >= 10 then left(d.num, 3)
      else null
    end
  limit 1
$$;
update crm_contacts
set tz_offset = contact_tz_offset(phones)
where jsonb_array_length(coalesce(phones, '[]'::jsonb)) > 0
  and tz_offset is distinct from contact_tz_offset(phones);
update crm_contacts_tz_backup_00185 b
set tz_offset_after = c.tz_offset
from crm_contacts c
where c.id = b.id;
