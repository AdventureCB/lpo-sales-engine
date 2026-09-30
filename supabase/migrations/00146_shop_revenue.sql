-- Revenue analytics: a local, line-level mirror of every Shopify order (full
-- history via the Admin API, read_all_orders) plus the product ↔ collection
-- map, so admin can slice net revenue by period, compare periods, and toggle
-- collections in/out. Shipping and tax are never part of revenue here.

create table shop_collections (
  id bigint primary key,
  title text not null,
  handle text,
  products_count integer,
  rule_based boolean not null default false,
  synced_at timestamptz not null default now()
);
alter table shop_collections enable row level security;

create table shop_products (
  id bigint primary key,
  title text not null,
  handle text,
  status text,
  product_type text not null default '',
  skus text[] not null default '{}',
  collection_ids bigint[] not null default '{}',
  synced_at timestamptz not null default now()
);
alter table shop_products enable row level security;
create index idx_shop_products_skus on shop_products using gin (skus);
create index idx_shop_products_collections on shop_products using gin (collection_ids);
create index idx_shop_products_title on shop_products (lower(title));

create table shop_orders (
  id bigint primary key,
  name text,
  created_at timestamptz not null,
  updated_at timestamptz,
  cancelled_at timestamptz,
  test boolean not null default false,
  financial_status text,
  customer_id bigint,
  customer_name text,
  customer_name_norm text,
  customer_email text,
  subtotal_cents integer not null default 0,
  discounts_cents integer not null default 0,
  shipping_cents integer not null default 0,
  tax_cents integer not null default 0,
  total_cents integer not null default 0,
  refunded_cents integer not null default 0,
  discount_codes jsonb not null default '[]'::jsonb,
  synced_at timestamptz not null default now()
);
alter table shop_orders enable row level security;
create index idx_shop_orders_created on shop_orders (created_at);
create index idx_shop_orders_cust on shop_orders (customer_name_norm);

create table shop_order_lines (
  id bigint primary key,
  order_id bigint not null references shop_orders(id) on delete cascade,
  product_id bigint,             -- from the API (needs read_products)
  resolved_product_id bigint,    -- product_id, else matched by SKU, else by title
  variant_id bigint,
  sku text,
  title text,
  quantity integer not null default 0,
  gross_cents integer not null default 0,     -- original line total, before discounts
  discount_cents integer not null default 0,  -- all discount allocations (line + order level)
  refund_cents integer not null default 0,    -- refunded line subtotal
  refund_qty integer not null default 0,
  discounts jsonb not null default '[]'::jsonb -- [{label, cents}]
);
alter table shop_order_lines enable row level security;
create index idx_shop_lines_order on shop_order_lines (order_id);
create index idx_shop_lines_product on shop_order_lines (resolved_product_id);

-- Resolve every line to a catalog product: explicit product id wins, then an
-- exact SKU match, then an exact (case-insensitive) title match.
create or replace function shop_resolve_lines()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update shop_order_lines l
  set resolved_product_id = coalesce(
    l.product_id,
    (select p.id from shop_products p where l.sku is not null and l.sku <> '' and p.skus @> array[l.sku] order by p.id limit 1),
    (select p.id from shop_products p where l.title is not null and lower(p.title) = lower(l.title) order by p.id limit 1)
  )
  where l.resolved_product_id is distinct from coalesce(
    l.product_id,
    (select p.id from shop_products p where l.sku is not null and l.sku <> '' and p.skus @> array[l.sku] order by p.id limit 1),
    (select p.id from shop_products p where l.title is not null and lower(p.title) = lower(l.title) order by p.id limit 1)
  );
  get diagnostics n = row_count;
  return n;
end $$;

-- The report. Revenue = line gross − discounts − refunded line amounts, for
-- lines whose product sits in any selected collection (or, when asked, lines
-- with no matched product / a product in no collection). Test, cancelled and
-- voided orders are out. Buckets are LA-local day/week/month.
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
lines as (
  select l.order_id, l.gross_cents, l.discount_cents, l.refund_cents, l.quantity, l.refund_qty, l.discounts,
         o.created_at, o.customer_name_norm, o.customer_name, o.customer_email, o.name as order_name
  from shop_order_lines l
  join shop_orders o on o.id = l.order_id
  left join prod p on p.id = l.resolved_product_id
  where o.created_at >= p_from and o.created_at < p_to
    and not o.test and o.cancelled_at is null
    and coalesce(o.financial_status, '') <> 'VOIDED'
    and (coalesce(p.selected, false) or (p_include_unmatched and (p.id is null or p.uncategorized)))
),
per_order as (
  select order_id, order_name, created_at, customer_name_norm, customer_name, customer_email,
         sum(gross_cents) as gross, sum(discount_cents) as disc, sum(refund_cents) as ref,
         sum(quantity) as units, sum(gross_cents - discount_cents - refund_cents) as net
  from lines
  group by 1, 2, 3, 4, 5, 6
  having sum(gross_cents) > 0
),
buckets as (
  select date_trunc(p_bucket, created_at at time zone 'America/Los_Angeles') as b,
         sum(gross) as gross, sum(disc) as disc, sum(ref) as ref, sum(net) as net, count(*) as orders
  from per_order group by 1
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
)
select jsonb_build_object(
  'totals', (select jsonb_build_object(
      'gross', coalesce(sum(gross), 0), 'discounts', coalesce(sum(disc), 0), 'returns', coalesce(sum(ref), 0),
      'net', coalesce(sum(net), 0), 'orders', count(*), 'units', coalesce(sum(units), 0)) from per_order),
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

-- Hourly incremental order sync during the work window; nightly catalog sync
-- (products/collections — needs the read_products scope on the Admin app).
select cron.schedule(
  'shop-orders-hourly',
  '12 * * * *',
  $$select net.http_get(url := 'https://lpo-sales-engine.vercel.app/api/cron/shop-orders-sync?incremental=1', headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')), timeout_milliseconds := 115000) where public.is_work_window()$$
);
select cron.schedule(
  'shop-catalog-daily',
  '40 8 * * *',
  $$select net.http_get(url := 'https://lpo-sales-engine.vercel.app/api/cron/shop-orders-sync?catalog=1', headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')), timeout_milliseconds := 115000)$$
);
