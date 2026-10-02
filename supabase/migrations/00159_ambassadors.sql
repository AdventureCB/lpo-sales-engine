-- Ambassador sales. Two signals: Shopify Collabs tags referred orders with a
-- `__ref_id` note attribute (affiliate link), and ambassadors have discount
-- codes — Collabs-generated ones historically, standard codes lately. The
-- roster maps codes (and, optionally, Collabs ref ids) to a name; an order
-- with a Collabs ref that maps to no one still counts as ambassador revenue
-- under "Collabs (unmapped)".
alter table shop_orders add column if not exists collabs_ref text;
create index if not exists idx_shop_orders_collabs on shop_orders (collabs_ref) where collabs_ref is not null;

create table ambassadors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  codes text[] not null default '{}',       -- discount codes, matched case-insensitively
  ref_ids text[] not null default '{}',     -- Collabs __ref_id values, exact
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table ambassadors enable row level security;

-- Per month × ambassador: orders, net revenue, discount given. An order
-- counts once; code match wins over ref match for naming.
create or replace function ambassador_sales_by_month(p_from timestamptz)
returns table (month date, ambassador_id uuid, ambassador text, via text, orders bigint, net_cents bigint, discount_cents bigint, customers bigint)
language sql stable security definer set search_path = public as $$
with ok as (
  select o.id, o.created_at, o.net_cents, o.customer_name_norm, o.collabs_ref,
         (select sum(l.discount_cents) from shop_order_lines l where l.order_id = o.id) as disc,
         (select array_agg(distinct upper(d->>'label')) from shop_order_lines l, jsonb_array_elements(l.discounts) d where l.order_id = o.id) as labels
  from shop_orders o
  where o.created_at >= p_from and not o.test and not o.test_checkout
    and coalesce(o.financial_status, '') not in ('PENDING', 'AUTHORIZED', 'VOIDED', 'EXPIRED')
    and o.net_cents > 0
),
amb as (
  select a.id, a.name, (select array_agg(upper(c)) from unnest(a.codes) c) as codes_u, a.ref_ids
  from ambassadors a where a.active
),
matched as (
  select o.*,
         (select a.id from amb a where o.labels && coalesce(a.codes_u, '{}') limit 1) as code_amb,
         (select a.id from amb a where o.collabs_ref is not null and o.collabs_ref = any(a.ref_ids) limit 1) as ref_amb
  from ok o
),
tagged as (
  select m.*,
         coalesce(m.code_amb, m.ref_amb) as amb_id,
         case when m.code_amb is not null then 'code' when m.ref_amb is not null then 'collabs' when m.collabs_ref is not null then 'collabs' else null end as via
  from matched m
  where m.code_amb is not null or m.ref_amb is not null or m.collabs_ref is not null
)
select (date_trunc('month', t.created_at at time zone 'America/Los_Angeles'))::date as month,
       t.amb_id as ambassador_id,
       coalesce(a.name, 'Collabs (unmapped)') as ambassador,
       t.via,
       count(*) as orders,
       sum(t.net_cents)::bigint as net_cents,
       coalesce(sum(t.disc), 0)::bigint as discount_cents,
       count(distinct coalesce(nullif(t.customer_name_norm, ''), t.id::text)) as customers
from tagged t
left join ambassadors a on a.id = t.amb_id
group by 1, 2, 3, 4
order by 1, 6 desc;
$$;

-- Discount codes seen on orders that belong to no known bucket, so the
-- roster can be built by clicking rather than guessing.
create or replace function ambassador_code_candidates(p_from timestamptz)
returns table (code text, orders bigint, net_cents bigint, first_at timestamptz, last_at timestamptz, collabs_orders bigint)
language sql stable security definer set search_path = public as $$
with rp as (select distinct upper(split_part(trim(name), ' ', 1)) as p from reps where length(trim(name)) >= 3),
amb_codes as (select upper(c) as c from ambassadors, unnest(codes) c),
labels as (
  select distinct o.id as order_id, o.created_at, o.net_cents, o.collabs_ref, upper(d->>'label') as code
  from shop_orders o
  join shop_order_lines l on l.order_id = o.id, jsonb_array_elements(l.discounts) d
  where o.created_at >= p_from and not o.test and not o.test_checkout and o.net_cents > 0
    and d->>'label' is not null and d->>'label' <> ''
)
select code, count(distinct order_id) as orders, sum(net_cents)::bigint as net_cents, min(created_at) as first_at, max(created_at) as last_at,
       count(distinct order_id) filter (where collabs_ref is not null) as collabs_orders
from labels
where code !~ '^LX-|^LXZ-' and code !~ 'DEPOSIT|DOWN ?PAYMENT|TEST|CUSTOM DISCOUNT|WARRANTY|SPLIT|CARRIED|^OTHER$|^DISCOUNT$|SURVEY|SALUTE|CHEERS|^DEMOMAP$|^UPGRADE$|FIRSTRESPONDER|INDUSTRY|PER ?-? ?KI|PER ?-? ?GM|^-?KI$|^BW$|^GM$|EXPO|CONFIRMED|DRAWERS|GEARVAULT|3ZLIGHTING|RAFFLE|SONOMA|TCG'
  and not exists (select 1 from rp where code ~ ('^' || rp.p || '([^A-Z]|$)'))
  and code not in (select c from amb_codes)
group by code
having count(distinct order_id) >= 2
order by orders desc
limit 150;
$$;
