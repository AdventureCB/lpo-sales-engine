-- `__ref_id` turned out to be Loox Referrals (Sep 2026 →), not Shopify
-- Collabs, so an unmapped ref id is NOT an ambassador sale. Ambassador sales
-- = roster codes on the order, or a ref id explicitly listed on the roster.
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
  select m.*, coalesce(m.code_amb, m.ref_amb) as amb_id,
         case when m.code_amb is not null then 'code' else 'ref' end as via
  from matched m
  where m.code_amb is not null or m.ref_amb is not null
)
select (date_trunc('month', t.created_at at time zone 'America/Los_Angeles'))::date as month,
       t.amb_id as ambassador_id, a.name as ambassador, t.via,
       count(*) as orders, sum(t.net_cents)::bigint as net_cents, coalesce(sum(t.disc), 0)::bigint as discount_cents,
       count(distinct coalesce(nullif(t.customer_name_norm, ''), t.id::text)) as customers
from tagged t
join ambassadors a on a.id = t.amb_id
group by 1, 2, 3, 4
order by 1, 6 desc;
$$;

-- Seed: codes that are plainly creator handles (Collabs-era). Kyle renames /
-- merges / removes from the roster UI; promos and random codes left for him.
insert into ambassadors (name, codes) values
  ('Landscapturer', '{LANDSCAPTURER}'),
  ('Modudeck', '{MODUDECK}'),
  ('Overland Cam', '{OVERLAND_CAM}'),
  ('Woody Petty', '{WOODYPETTY}'),
  ('Upper Left Adventures', '{UPPER_LEFT_ADVENTURES2025,UPPER_LEFT_ADVENTURES}'),
  ('Bud Loomis', '{BUDLOOMIS}'),
  ('Steel On Target', '{STEEL_ON_TARGET_YOUTUBE}'),
  ('Daniel Guilfoy', '{DANIELGUILFOY}'),
  ('Simple Instinct', '{SIMPLE_INSTINCT}'),
  ('Bad Overland', '{BADOVERLAND}'),
  ('Briar', '{BRIAR}'),
  ('Digstick', '{DIGSTICK}'),
  ('Ilona Moiseeva', '{ILONAMOISEEVA238}'),
  ('The Overland Shop VT', '{THEOVERLANDSHOPVT2025}'),
  ('Welcome To The Outdoors', '{WELCOMETOTHEOUTDOORS}'),
  ('Wolf Overland', '{WOLFOVERLAND}'),
  ('The Great Outdoors', '{THEGREATOUTDOORS}'),
  ('Rab The Rover', '{RAB_THE_ROVER}'),
  ('The Traction Factory', '{THETRACTIONFACTORY}')
on conflict do nothing;
