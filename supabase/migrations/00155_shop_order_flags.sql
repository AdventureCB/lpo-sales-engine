-- Performance: the report RPCs were re-deriving per-order facts (test
-- checkout, rep-coded discount, staff-built) by expanding every line's
-- discount jsonb on every call — the purchase-source query took ~30s and the
-- page hit statement timeouts. Compute them once per sync instead.
alter table shop_orders add column if not exists test_checkout boolean not null default false;
alter table shop_orders add column if not exists rep_code boolean not null default false;
alter table shop_orders add column if not exists staff_built boolean not null default false;
alter table shop_orders add column if not exists net_cents integer not null default 0; -- all lines, no collection filter
create index if not exists idx_crm_deals_contact on crm_deals (contact_id);
create index if not exists idx_shop_orders_email on shop_orders (customer_email);

create or replace function shop_refresh_order_flags()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with rp as (
    select distinct upper(split_part(trim(name), ' ', 1)) as prefix from reps
    where length(trim(name)) >= 3
  ),
  per_order as (
    select l.order_id,
           sum(l.gross_cents - l.discount_cents - l.refund_cents) as net,
           sum(l.gross_cents - l.discount_cents) as net_before_refunds
    from shop_order_lines l group by 1
  ),
  labels as (
    select l.order_id, upper(coalesce(d->>'label', '')) as label
    from shop_order_lines l, jsonb_array_elements(l.discounts) d
  ),
  flags as (
    select o.id,
           coalesce(p.net, 0) as net,
           exists (select 1 from labels x where x.order_id = o.id and x.label ~* 'TEST')
             and coalesce(p.net_before_refunds, 0) <= 5000 as test_checkout,
           exists (select 1 from labels x, rp where x.order_id = o.id and x.label ~ ('^' || rp.prefix || '([^A-Z]|$)')) as rep_code,
           coalesce(o.source_name, '') in ('shopify_draft_order', 'pos') as staff_built
    from shop_orders o
    left join per_order p on p.order_id = o.id
  )
  update shop_orders o
  set test_checkout = f.test_checkout, rep_code = f.rep_code, staff_built = f.staff_built, net_cents = f.net
  from flags f
  where f.id = o.id
    and (o.test_checkout is distinct from f.test_checkout or o.rep_code is distinct from f.rep_code
         or o.staff_built is distinct from f.staff_built or o.net_cents is distinct from f.net);
  get diagnostics n = row_count;
  return n;
end $$;

select shop_refresh_order_flags();

-- Revenue report: same semantics, test checkouts via the flag.
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
ok_orders as (
  select o.* from shop_orders o
  where not o.test and not o.test_checkout
    and coalesce(o.financial_status, '') not in ('PENDING', 'AUTHORIZED', 'VOIDED', 'EXPIRED')
),
sel_lines as (
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

-- Shared purchase clustering (collection-filtered per-order net).
create or replace function shop_purchases(
  p_collections bigint[],
  p_include_unmatched boolean,
  p_threshold_cents integer,
  p_gap_days integer
) returns table (
  ckey text, purchase_no bigint, last_big_at timestamptz, value bigint,
  first_staff_built boolean, rep_code boolean, email text
)
language sql stable security definer set search_path = public as $$
with prod as (
  select id,
         cardinality(collection_ids) = 0 as uncategorized,
         collection_ids && coalesce(p_collections, '{}'::bigint[]) as selected
  from shop_products
),
per_order as (
  select o.id as order_id, o.created_at, o.customer_email, o.staff_built, o.rep_code,
         coalesce(nullif(o.customer_name_norm, ''), o.customer_email, o.id::text) as ckey,
         sum(l.gross_cents - l.discount_cents - l.refund_cents) as net
  from shop_orders o
  join shop_order_lines l on l.order_id = o.id
  left join prod p on p.id = l.resolved_product_id
  where not o.test and not o.test_checkout
    and coalesce(o.financial_status, '') not in ('PENDING', 'AUTHORIZED', 'VOIDED', 'EXPIRED')
    and (coalesce(p.selected, false) or (p_include_unmatched and (p.id is null or p.uncategorized)))
  group by 1, 2, 3, 4, 5, 6
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
)
select a.ckey, a.purchase_no, a.last_big_at,
       sum(c.net) filter (where c.created_at <= a.last_big_at + interval '60 days')::bigint as value,
       (array_agg(c.staff_built order by c.created_at))[1] as first_staff_built,
       bool_or(c.rep_code) filter (where c.created_at <= a.last_big_at) as rep_code,
       min(c.customer_email) as email
from anchored a
join clustered c on c.ckey = a.ckey and c.purchase_no = a.purchase_no
group by 1, 2, 3;
$$;

create or replace function shop_customer_value_by_month(
  p_from timestamptz,
  p_collections bigint[],
  p_include_unmatched boolean default true,
  p_threshold_cents integer default 500000,
  p_gap_days integer default 180
) returns table (month date, purchases bigint, total_cents bigint, avg_cents bigint, median_cents bigint)
language sql stable security definer set search_path = public as $$
select (date_trunc('month', last_big_at at time zone 'America/Los_Angeles'))::date as month,
       count(*) as purchases,
       sum(value)::bigint as total_cents,
       round(avg(value))::bigint as avg_cents,
       (percentile_cont(0.5) within group (order by value))::bigint as median_cents
from shop_purchases(p_collections, p_include_unmatched, p_threshold_cents, p_gap_days)
where last_big_at >= p_from
group by 1
order by 1;
$$;

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
with crm_touch as (
  -- deals with a real rep conversation → every email on the deal's contact
  select lower(e->>'value') as email, d.first_contact_at
  from crm_deals d
  join crm_contacts ct on ct.id = d.contact_id
  cross join lateral jsonb_array_elements(ct.emails) e
  where d.first_contact_at is not null and e->>'value' is not null
),
p as (
  select * from shop_purchases(p_collections, p_include_unmatched, p_threshold_cents, p_gap_days)
  where last_big_at >= p_from
),
with_crm as (
  select p.*,
         exists (
           select 1 from crm_touch t
           where t.email = lower(p.email)
             and t.first_contact_at < p.last_big_at
             and t.first_contact_at >= p.last_big_at - make_interval(days => p_gap_days)
         ) as crm
  from p
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
