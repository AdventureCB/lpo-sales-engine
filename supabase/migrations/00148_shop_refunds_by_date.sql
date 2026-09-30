-- Align with Shopify's sales reports: gross/discounts book on the order date,
-- returns book on the REFUND date, every non-test order counts (zero-dollar
-- and cancelled included — cancellations show up as returns).
create table shop_order_refunds (
  refund_id bigint not null,
  line_id bigint not null,
  order_id bigint not null references shop_orders(id) on delete cascade,
  created_at timestamptz not null,
  cents integer not null default 0,
  qty integer not null default 0,
  primary key (refund_id, line_id)
);
alter table shop_order_refunds enable row level security;
create index idx_shop_refunds_created on shop_order_refunds (created_at);
create index idx_shop_refunds_order on shop_order_refunds (order_id);

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
sel_lines as (
  -- every line whose product passes the collection filter (no date filter)
  select l.id, l.order_id, l.gross_cents, l.discount_cents, l.refund_cents, l.quantity, l.discounts
  from shop_order_lines l
  left join prod p on p.id = l.resolved_product_id
  where coalesce(p.selected, false) or (p_include_unmatched and (p.id is null or p.uncategorized))
),
lines as (
  select s.*, o.created_at, o.customer_name_norm, o.customer_name, o.customer_email, o.name as order_name
  from sel_lines s
  join shop_orders o on o.id = s.order_id
  where o.created_at >= p_from and o.created_at < p_to
    and not o.test and coalesce(o.financial_status, '') <> 'VOIDED'
),
refunds as (
  select r.created_at, r.cents
  from shop_order_refunds r
  join sel_lines s on s.id = r.line_id
  join shop_orders o on o.id = r.order_id
  where r.created_at >= p_from and r.created_at < p_to and not o.test
),
per_order as (
  select order_id, order_name, created_at, customer_name_norm, customer_name, customer_email,
         sum(gross_cents) as gross, sum(discount_cents) as disc, sum(refund_cents) as ref,
         sum(quantity) as units, sum(gross_cents - discount_cents - refund_cents) as net
  from lines
  group by 1, 2, 3, 4, 5, 6
),
b_orders as (
  select date_trunc(p_bucket, created_at at time zone 'America/Los_Angeles') as b,
         sum(gross) as gross, sum(disc) as disc, count(*) as orders
  from per_order group by 1
),
b_refunds as (
  select date_trunc(p_bucket, created_at at time zone 'America/Los_Angeles') as b, sum(cents) as ref
  from refunds group by 1
),
buckets as (
  select coalesce(o.b, r.b) as b,
         coalesce(o.gross, 0) as gross, coalesce(o.disc, 0) as disc, coalesce(r.ref, 0) as ref,
         coalesce(o.gross, 0) - coalesce(o.disc, 0) - coalesce(r.ref, 0) as net,
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
  group by 1
),
tot as (
  select coalesce(sum(gross), 0) as gross, coalesce(sum(disc), 0) as discounts, count(*) as orders, coalesce(sum(units), 0) as units
  from per_order
),
ret as (select coalesce(sum(cents), 0) as returns from refunds)
select jsonb_build_object(
  'totals', (select jsonb_build_object(
      'gross', tot.gross, 'discounts', tot.discounts, 'returns', ret.returns,
      'net', tot.gross - tot.discounts - ret.returns, 'orders', tot.orders, 'units', tot.units) from tot, ret),
  'big', jsonb_build_object(
      'orders', (select count(*) from per_order where net > p_threshold_cents),
      'customers', (select count(*) from big),
      'list', coalesce((select jsonb_agg(to_jsonb(big) order by big.net desc) from big), '[]'::jsonb)),
  'series', coalesce((select jsonb_agg(jsonb_build_object(
      'bucket', to_char(b, 'YYYY-MM-DD'), 'gross', gross, 'discounts', disc, 'returns', ref, 'net', net, 'orders', orders)
      order by b) from buckets), '[]'::jsonb),
  'discounts', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'cents', cents, 'orders', orders) order by cents desc) from disc), '[]'::jsonb)
);
$$;
