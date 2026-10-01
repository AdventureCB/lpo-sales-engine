-- The crm_touch CTE was being inlined and re-evaluated per purchase (~20s).
-- Materialize it once; it is a few hundred rows.
create or replace function shop_camper_purchases_by_source(
  p_from timestamptz,
  p_collections bigint[],
  p_include_unmatched boolean default true,
  p_threshold_cents integer default 500000,
  p_gap_days integer default 180
) returns table (
  month date,
  sales_purchases bigint, sales_cents bigint,
  organic_purchases bigint, organic_cents bigint,
  sig_draft bigint, sig_repcode bigint, sig_crm bigint
)
language sql stable security definer set search_path = public as $$
with crm_touch as materialized (
  select lower(e->>'value') as email, d.first_contact_at
  from crm_deals d
  join crm_contacts ct on ct.id = d.contact_id
  cross join lateral jsonb_array_elements(ct.emails) e
  where d.first_contact_at is not null and e->>'value' is not null
),
p as materialized (
  select * from shop_purchases(p_collections, p_include_unmatched, p_threshold_cents, p_gap_days)
  where last_big_at >= p_from
),
crm_hit as materialized (
  select distinct p.ckey, p.purchase_no
  from p
  join crm_touch t on t.email = lower(p.email)
  where t.first_contact_at < p.last_big_at
    and t.first_contact_at >= p.last_big_at - make_interval(days => p_gap_days)
),
with_crm as (
  select p.*, (h.ckey is not null) as crm
  from p
  left join crm_hit h on h.ckey = p.ckey and h.purchase_no = p.purchase_no
)
select (date_trunc('month', last_big_at at time zone 'America/Los_Angeles'))::date as month,
       count(*) filter (where first_staff_built or rep_code or crm) as sales_purchases,
       coalesce(sum(value) filter (where first_staff_built or rep_code or crm), 0)::bigint as sales_cents,
       count(*) filter (where not (first_staff_built or rep_code or crm)) as organic_purchases,
       coalesce(sum(value) filter (where not (first_staff_built or rep_code or crm)), 0)::bigint as organic_cents,
       count(*) filter (where first_staff_built) as sig_draft,
       count(*) filter (where rep_code) as sig_repcode,
       count(*) filter (where crm) as sig_crm
from with_crm
group by 1
order by 1;
$$;
