-- Staff signal = the FIRST order of the purchase was staff-built (draft order or POS).
-- Since Apr 2026 every camper balance is invoiced via a draft order, so "any
-- staff-built order" stopped discriminating; whether the customer STARTED on the
-- website still does. Shop app / Buy Button / checkout_next are customer-driven.
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
with prod as (
  select id,
         cardinality(collection_ids) = 0 as uncategorized,
         collection_ids && coalesce(p_collections, '{}'::bigint[]) as selected
  from shop_products
),
test_orders as (
  select l.order_id
  from shop_order_lines l
  where l.order_id in (
    select x.order_id from shop_order_lines x, jsonb_array_elements(x.discounts) d
    where d->>'label' ~* 'test'
  )
  group by l.order_id
  having sum(l.gross_cents - l.discount_cents) <= 5000
),
ok_orders as (
  select o.*
  from shop_orders o
  where not o.test
    and coalesce(o.financial_status, '') not in ('PENDING', 'AUTHORIZED', 'VOIDED', 'EXPIRED')
    and o.id not in (select order_id from test_orders)
),
rep_prefixes as (
  select distinct upper(split_part(trim(name), ' ', 1)) as prefix from reps where length(trim(name)) > 0
),
per_order as (
  select o.id as order_id, o.created_at, o.customer_email,
         coalesce(nullif(o.customer_name_norm, ''), o.customer_email, o.id::text) as ckey,
         sum(l.gross_cents - l.discount_cents - l.refund_cents) as net,
         (coalesce(o.source_name, '') in ('shopify_draft_order', 'pos')) as is_draft,
         exists (
           select 1 from shop_order_lines x, jsonb_array_elements(x.discounts) d, rep_prefixes rp
           where x.order_id = o.id and length(rp.prefix) >= 3
             and upper(coalesce(d->>'label', '')) ~ ('^' || rp.prefix || '([^A-Z]|$)')
         ) as is_repcode
  from shop_order_lines l
  join ok_orders o on o.id = l.order_id
  left join prod p on p.id = l.resolved_product_id
  where coalesce(p.selected, false) or (p_include_unmatched and (p.id is null or p.uncategorized))
  group by 1, 2, 3, 4, 6, 7
),
seq as (
  select *,
         case when created_at - lag(created_at) over (partition by ckey order by created_at)
                   > make_interval(days => p_gap_days) or lag(created_at) over (partition by ckey order by created_at) is null
              then 1 else 0 end as starts
  from per_order
),
clustered as (
  select *, sum(starts) over (partition by ckey order by created_at rows unbounded preceding) as purchase_no
  from seq
),
anchored as (
  select ckey, purchase_no, max(created_at) filter (where net > p_threshold_cents) as last_big_at
  from clustered
  group by 1, 2
  having max(net) > p_threshold_cents
),
purchases as (
  select a.ckey, a.purchase_no, a.last_big_at,
         sum(c.net) filter (where c.created_at <= a.last_big_at + interval '60 days') as value,
         (array_agg(c.is_draft order by c.created_at))[1] as draft,
         bool_or(c.is_repcode) filter (where c.created_at <= a.last_big_at) as repcode,
         min(c.customer_email) as email
  from anchored a
  join clustered c on c.ckey = a.ckey and c.purchase_no = a.purchase_no
  where a.last_big_at >= p_from
  group by 1, 2, 3
),
with_crm as (
  select p.*,
         exists (
           select 1
           from crm_contacts ct
           join crm_deals d on d.contact_id = ct.id
           where p.email is not null
             and ct.emails @> jsonb_build_array(jsonb_build_object('value', p.email))
             and d.first_contact_at is not null
             and d.first_contact_at < p.last_big_at
             and d.first_contact_at >= p.last_big_at - make_interval(days => p_gap_days)
         ) as crm
  from purchases p
)
select (date_trunc('month', last_big_at at time zone 'America/Los_Angeles'))::date as month,
       count(*) filter (where draft or repcode or crm) as sales_purchases,
       coalesce(sum(value) filter (where draft or repcode or crm), 0)::bigint as sales_cents,
       count(*) filter (where not (draft or repcode or crm)) as organic_purchases,
       coalesce(sum(value) filter (where not (draft or repcode or crm)), 0)::bigint as organic_cents,
       count(*) filter (where draft) as sig_draft,
       count(*) filter (where repcode) as sig_repcode,
       count(*) filter (where crm) as sig_crm
from with_crm
group by 1
order by 1;
$$;
