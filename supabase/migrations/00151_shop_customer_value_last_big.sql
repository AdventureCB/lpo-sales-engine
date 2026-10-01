-- Customer value by month, corrected (Kyle 10/1): a purchase lands in the
-- month of its last CAMPER-SIZED payment (net > threshold), not its last order
-- of any size — a small accessory bought months later was dragging whole
-- purchases forward (Sep 2026 showed 112 instead of ~24). Its value is every
-- order in the purchase up to 60 days after that last big payment, so
-- install-time add-ons count but later accessories neither move nor inflate it.
create or replace function shop_customer_value_by_month(
  p_from timestamptz,
  p_collections bigint[],
  p_include_unmatched boolean default true,
  p_threshold_cents integer default 500000,
  p_gap_days integer default 180
) returns table (month date, purchases bigint, total_cents bigint, avg_cents bigint, median_cents bigint)
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
per_order as (
  select o.id as order_id, o.created_at,
         coalesce(nullif(o.customer_name_norm, ''), o.customer_email, o.id::text) as ckey,
         sum(l.gross_cents - l.discount_cents - l.refund_cents) as net
  from shop_order_lines l
  join ok_orders o on o.id = l.order_id
  left join prod p on p.id = l.resolved_product_id
  where coalesce(p.selected, false) or (p_include_unmatched and (p.id is null or p.uncategorized))
  group by 1, 2, 3
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
         sum(c.net) filter (where c.created_at <= a.last_big_at + interval '60 days') as value
  from anchored a
  join clustered c on c.ckey = a.ckey and c.purchase_no = a.purchase_no
  group by 1, 2, 3
)
select (date_trunc('month', last_big_at at time zone 'America/Los_Angeles'))::date as month,
       count(*) as purchases,
       sum(value)::bigint as total_cents,
       round(avg(value))::bigint as avg_cents,
       (percentile_cont(0.5) within group (order by value))::bigint as median_cents
from purchases
where last_big_at >= p_from
group by 1
order by 1;
$$;
