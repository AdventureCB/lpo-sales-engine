-- Deal value defaults (Kyle 9/22):
--   • every NEW deal starts at $12,000 (adjusted through the sales process),
--   • a deal moved INTO the Base Camp List pipeline becomes $8,500,
--   • backfill: open deals at $0 → $12,000; open Base Camp deals → $8,500.
-- Lost deals and the Confirmation Pipeline are never touched. Done as a trigger
-- so it holds for every creation path (native form, intake engines, Typeform,
-- abandoned cart, imports), not just the app's create endpoint.

create or replace function public.crm_deal_default_value()
returns trigger
language plpgsql
as $$
declare
  pipe text;
begin
  select p.name into pipe
  from crm_stages s join crm_pipelines p on p.id = s.pipeline_id
  where s.id = new.stage_id;

  if tg_op = 'INSERT' then
    if pipe ilike '%base camp%' then
      new.value_cents := 850000;
    elsif coalesce(new.value_cents, 0) = 0 and coalesce(pipe, '') not ilike '%confirmation%' then
      new.value_cents := 1200000;
    end if;
  elsif tg_op = 'UPDATE' then
    -- Only a MOVE into Base Camp resets the value; ordinary value edits and
    -- moves elsewhere leave it alone.
    if new.stage_id is distinct from old.stage_id and pipe ilike '%base camp%' then
      new.value_cents := 850000;
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists crm_deal_default_value on crm_deals;
create trigger crm_deal_default_value
  before insert or update of stage_id on crm_deals
  for each row execute function public.crm_deal_default_value();

-- Backfill 1: open Base Camp deals → $8,500.
update crm_deals d
set value_cents = 850000, updated_at = now()
where d.status = 'open'
  and d.value_cents is distinct from 850000
  and exists (
    select 1 from crm_stages s join crm_pipelines p on p.id = s.pipeline_id
    where s.id = d.stage_id and p.name ilike '%base camp%'
  );

-- Backfill 2: open deals with no value → $12,000 (not Confirmation, not Base Camp).
update crm_deals d
set value_cents = 1200000, updated_at = now()
where d.status = 'open'
  and coalesce(d.value_cents, 0) = 0
  and not exists (
    select 1 from crm_stages s join crm_pipelines p on p.id = s.pipeline_id
    where s.id = d.stage_id and (p.name ilike '%confirmation%' or p.name ilike '%base camp%')
  );
