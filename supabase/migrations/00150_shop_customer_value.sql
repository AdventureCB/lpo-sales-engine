-- Average camper-customer value by month. A customer's orders are grouped
-- into one "purchase" while each order is within p_gap_days of the previous
-- one; the purchase counts when any order in it nets more than the threshold
-- (a camper), its value is the sum of every order in it (deposit included),
-- and it lands in the month of its LAST payment. Same order/line rules and
-- collection filter as shop_revenue_report.
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
purchases as (
  select ckey, purchase_no, sum(net) as value, max(net) as biggest, max(created_at) as last_at, count(*) as orders
  from clustered
  group by 1, 2
  having max(net) > p_threshold_cents
)
select (date_trunc('month', last_at at time zone 'America/Los_Angeles'))::date as month,
       count(*) as purchases,
       sum(value)::bigint as total_cents,
       round(avg(value))::bigint as avg_cents,
       (percentile_cont(0.5) within group (order by value))::bigint as median_cents
from purchases
where last_at >= p_from
group by 1
order by 1;
$$;
