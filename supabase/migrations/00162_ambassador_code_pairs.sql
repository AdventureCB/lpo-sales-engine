-- Standard ambassador codes come in pairs: NAME500 (deposit) + NAME500C
-- (remaining balance). A roster code therefore also matches itself + 'C',
-- so assigning NAME500 covers both halves.
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
  select a.id, a.name,
         (select array_agg(x) from (select upper(c) from unnest(a.codes) c union select upper(c) || 'C' from unnest(a.codes) c) s(x)) as codes_u,
         a.ref_ids
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

create or replace function ambassador_code_candidates(p_from timestamptz)
returns table (code text, orders bigint, net_cents bigint, first_at timestamptz, last_at timestamptz, collabs_orders bigint)
language sql stable security definer set search_path = public as $$
with rp as (select distinct upper(split_part(trim(name), ' ', 1)) as p from reps where length(trim(name)) >= 3),
amb_codes as (select upper(c) as c from ambassadors, unnest(codes) c union select upper(c) || 'C' from ambassadors, unnest(codes) c),
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
where code !~ '^LX-|^LXZ-' and code !~ 'DEPOSIT|DOWN ?PAYMENT|TEST|CUSTOM DISCOUNT|WARRANTY|SPLIT|CARRIED|^OTHER$|^DISCOUNT$|SURVEY|SALUTE|CHEERS|^DEMOMAP$|^UPGRADE$|FIRSTRESPONDER|INDUSTRY|PER ?-? ?KI|PER ?-? ?GM|^-?KI$|^BW$|^GM$|EXPO|CONFIRMED|DRAWERS|GEARVAULT|3ZLIGHTING|RAFFLE|SONOMA'
  and not exists (select 1 from rp where code ~ ('^' || rp.p || '([^A-Z]|$)'))
  and code not in (select c from amb_codes)
group by code
having count(distinct order_id) >= 2
order by orders desc
limit 150;
$$;

-- Seed the NAME500 pairs that exist in Shopify (10/2). Five belong to
-- ambassadors already on the roster from their Collabs-era codes.
update ambassadors set codes = array_append(codes, 'OVERLANDCAM500'), updated_at = now() where name = 'Overland Cam' and not ('OVERLANDCAM500' = any(codes));
update ambassadors set codes = array_append(codes, 'RABTHEROVER500'), updated_at = now() where name = 'Rab The Rover' and not ('RABTHEROVER500' = any(codes));
update ambassadors set codes = array_append(codes, 'SIMPLEINSTINCT500'), updated_at = now() where name = 'Simple Instinct' and not ('SIMPLEINSTINCT500' = any(codes));
update ambassadors set codes = array_append(codes, 'WOLFOVERLAND500'), updated_at = now() where name = 'Wolf Overland' and not ('WOLFOVERLAND500' = any(codes));
update ambassadors set codes = array_append(codes, 'THEOVERLANDSHO500'), updated_at = now() where name = 'The Overland Shop VT' and not ('THEOVERLANDSHO500' = any(codes));
insert into ambassadors (name, codes) values
  ('4WD Degens', '{4WDEGENS500}'), ('Adrian Tovar', '{ADRIANTOVAR500}'), ('Andrew Jones', '{ANDREWJONES500}'),
  ('Colter Tru', '{COLTERTRU500}'), ('Dain', '{DAIN500}'), ('Doubled Overland', '{DOUBLEDOVERLAN500}'),
  ('Fabs World', '{FABSWORLD500}'), ('First Due Overland', '{FIRSTDUEOVERLA500}'), ('Isolines', '{ISOLINES500}'),
  ('Kecia Ice', '{KECIAICE500}'), ('Lone Peak Taco', '{LONEPEAKTACO500,LONEPEAKTACO}'), ('Matty Daddy', '{MATTYDADDY500}'),
  ('Moventure', '{MOVENTURE500}'), ('MYCB Tech', '{MYCBTECH500}'), ('Myriad MFG', '{MYRIADMFG500}'),
  ('Oregon Gear Guy', '{OREGONGEARGUY500}'), ('PSE', '{PSE500}'), ('R2R Overland', '{R2ROVERLAND500}'),
  ('Ryan Welch', '{RYANWELCH500}'), ('TCG', '{TCG500,TCG26,TCG25-CONFIRMED}'), ('Thee Antihero', '{THEEANTIHERO500}'),
  ('Trout Cowboy', '{TROUTCOWBOY500}'), ('ULAG', '{ULAG500}'), ('Wanderlust', '{WANDERLUST500}'),
  ('Wired By Greg', '{WIREDBYGREG500}'), ('Yitbos Adventures', '{YITBOSADVENTUR500}')
on conflict do nothing;
