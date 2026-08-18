-- CRM list search matched title only. Add a trigger-maintained search_blob
-- (title + contact name + emails + phone digits + source name) so one ilike
-- composes with every existing filter/sort/pagination on the deals listing.
-- Reuses the normalizers: contact_email_set (00065, lowercased) and
-- contact_phone_set (00086, last-10 digits).

alter table crm_deals add column if not exists search_blob text;

create or replace function public.build_deal_search_blob(p_title text, p_contact_id uuid, p_source_id uuid)
returns text
language sql
stable
as $$
  select lower(
    coalesce(p_title, '') || ' ' ||
    coalesce(c.name, '') || ' ' ||
    coalesce(array_to_string(public.contact_email_set(c.emails), ' '), '') || ' ' ||
    coalesce(array_to_string(public.contact_phone_set(c.phones), ' '), '') || ' ' ||
    coalesce(s.name, '')
  )
  from (select 1) one
  left join crm_contacts c on c.id = p_contact_id
  left join deal_sources s on s.id = p_source_id
$$;

-- Deal writes keep their own blob fresh. BEFORE trigger sets the column
-- directly — no recursive UPDATE.
create or replace function public.trg_deal_search_blob()
returns trigger language plpgsql as $$
begin
  new.search_blob := public.build_deal_search_blob(new.title, new.contact_id, new.source_id);
  return new;
end $$;

drop trigger if exists deal_search_blob on crm_deals;
create trigger deal_search_blob
  before insert or update of title, contact_id, source_id on crm_deals
  for each row execute function public.trg_deal_search_blob();

-- Contact edits (name/emails/phones) refresh that contact's deals. The
-- refresh only writes search_blob, which is NOT in the deal trigger's
-- column list — no cascade.
create or replace function public.trg_contact_search_blob()
returns trigger language plpgsql as $$
begin
  update crm_deals
    set search_blob = public.build_deal_search_blob(title, contact_id, source_id)
    where contact_id = new.id;
  return new;
end $$;

drop trigger if exists contact_search_blob on crm_contacts;
create trigger contact_search_blob
  after update of name, emails, phones on crm_contacts
  for each row execute function public.trg_contact_search_blob();

-- Source renames are rare but cheap to keep correct.
create or replace function public.trg_source_search_blob()
returns trigger language plpgsql as $$
begin
  update crm_deals
    set search_blob = public.build_deal_search_blob(title, contact_id, source_id)
    where source_id = new.id;
  return new;
end $$;

drop trigger if exists source_search_blob on deal_sources;
create trigger source_search_blob
  after update of name on deal_sources
  for each row execute function public.trg_source_search_blob();

-- Substring (%needle%) search stays indexed as the mirror grows.
create extension if not exists pg_trgm;
create index if not exists idx_crm_deals_search_blob
  on crm_deals using gin (search_blob gin_trgm_ops);

update crm_deals set search_blob = public.build_deal_search_blob(title, contact_id, source_id);
