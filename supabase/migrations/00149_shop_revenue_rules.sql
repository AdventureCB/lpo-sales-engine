-- Revenue report rules (Kyle 9/30):
--  * unpaid orders never count (PENDING / AUTHORIZED / VOIDED / EXPIRED)
--  * staff test checkouts (a "test…" discount code that zeroes the order) are out
--  * "deposit" / "down payment" discounts are payment credits for money already
--    taken on an earlier order: they still reduce net (no double count) but are
--    NOT "lost to discounts" and don't appear in the discount breakdown.
create or replace function shop_revenue_report(
  p_from timestamptz,
  p_to timestamptz,
  p_collections bigint[],
  p_include_unmatched boolean default true,
  p_threshold_cents integer default 500000,
  p_bucket text default 'month'
) returns jsonb language sql stable security definer set search_path = public as $$
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
sel_lines as (
  -- every line whose product passes the collection filter (no date filter)
  select l.id, l.order_id, l.gross_cents, l.discount_cents, l.refund_cents, l.quantity, l.discounts,
         coalesce((select sum((d->>'cents')::bigint) from jsonb_array_elements(l.discounts) d
                   where d->>'label' ~* 'deposit|down ?payment'), 0)::integer as deposit_cents
  from shop_order_lines l
  left join prod p on p.id = l.resolved_product_id
  where coalesce(p.selected, false) or (p_include_unmatched and (p.id is null or p.uncategorized))
),
lines as (
  select s.*, o.created_at, o.customer_name_norm, o.customer_name, o.customer_email, o.name as order_name
  from sel_lines s
  join ok_orders o on o.id = s.order_id
  where o.created_at >= p_from and o.created_at < p_to
),
refunds as (
  select r.created_at, r.cents
  from shop_order_refunds r
  join sel_lines s on s.id = r.line_id
  join ok_orders o on o.id = r.order_id
  where r.created_at >= p_from and r.created_at < p_to
),
per_order as (
  select order_id, order_name, created_at, customer_name_norm, customer_name, customer_email,
         sum(gross_cents) as gross, sum(discount_cents) as disc_all,
         sum(discount_cents - deposit_cents) as disc, sum(deposit_cents) as deposit,
         sum(refund_cents) as ref, sum(quantity) as units,
         sum(gross_cents - discount_cents - refund_cents) as net
  from lines
  group by 1, 2, 3, 4, 5, 6
),
b_orders as (
  select date_trunc(p_bucket, created_at at time zone 'America/Los_Angeles') as b,
         sum(gross) as gross, sum(disc) as disc, sum(deposit) as deposit, sum(disc_all) as disc_all, count(*) as orders
  from per_order group by 1
),
b_refunds as (
  select date_trunc(p_bucket, created_at at time zone 'America/Los_Angeles') as b, sum(cents) as ref
  from refunds group by 1
),
buckets as (
  select coalesce(o.b, r.b) as b,
         coalesce(o.gross, 0) as gross, coalesce(o.disc, 0) as disc, coalesce(o.deposit, 0) as deposit,
         coalesce(r.ref, 0) as ref,
         coalesce(o.gross, 0) - coalesce(o.disc_all, 0) - coalesce(r.ref, 0) as net,
         coalesce(o.orders, 0) as orders
  from b_orders o full outer join b_refunds r on r.b = o.b
),
big as (
  select coalesce(nullif(customer_name_norm, ''), customer_email, order_id::text) as ckey,
         max(customer_name) as customer_name, max(customer_email) as email,
         count(*) as orders, sum(net) as net, min(created_at) as first_at, max(created_at) as last_at,
         array_agg(order_name order by created_at) as order_names
  from per_order
  where net > p_threshold_cents
  group by 1
),
disc as (
  select coalesce(d->>'label', 'Other') as label, sum((d->>'cents')::bigint) as cents, count(distinct order_id) as orders
  from lines, jsonb_array_elements(discounts) d
  where coalesce(d->>'label', '') !~* 'deposit|down ?payment'
  group by 1
),
tot as (
  select coalesce(sum(gross), 0) as gross, coalesce(sum(disc), 0) as discounts, coalesce(sum(deposit), 0) as deposit,
         coalesce(sum(disc_all), 0) as disc_all, count(*) as orders, coalesce(sum(units), 0) as units
  from per_order
),
ret as (select coalesce(sum(cents), 0) as returns from refunds)
select jsonb_build_object(
  'totals', (select jsonb_build_object(
      'gross', tot.gross, 'discounts', tot.discounts, 'depositCredits', tot.deposit, 'returns', ret.returns,
      'net', tot.gross - tot.disc_all - ret.returns, 'orders', tot.orders, 'units', tot.units) from tot, ret),
  'big', jsonb_build_object(
      'orders', (select count(*) from per_order where net > p_threshold_cents),
      'customers', (select count(*) from big),
      'list', coalesce((select jsonb_agg(to_jsonb(big) order by big.net desc) from big), '[]'::jsonb)),
  'series', coalesce((select jsonb_agg(jsonb_build_object(
      'bucket', to_char(b, 'YYYY-MM-DD'), 'gross', gross, 'discounts', disc, 'depositCredits', deposit,
      'returns', ref, 'net', net, 'orders', orders)
      order by b) from buckets), '[]'::jsonb),
  'discounts', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'cents', cents, 'orders', orders) order by cents desc) from disc), '[]'::jsonb)
);
$$;
