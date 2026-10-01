-- Revenue that should actually be attributed to Klaviyo (Kyle 10/1): orders
-- with NO sales-person involvement where the customer's email had a Klaviyo
-- click (strong) or only an open (weak) in the p_window_days before the
-- order. All lines count (accessories and merch included), net per order.
-- "No sales person" follows the purchase rules of the sales-vs-organic chart:
-- an order inside a camper purchase inherits that purchase's status (first
-- order was the customer's own web checkout, no rep code through the last
-- camper payment, no logged rep conversation in the prior p_gap_days); an
-- order outside any camper purchase is judged on its own (not staff-built,
-- no rep code, no conversation). Balance invoices are always staff-built, so
-- judging them per order would hide almost all camper revenue.
create or replace function shop_klaviyo_attribution_by_month(
  p_from timestamptz,
  p_window_days integer default 5,
  p_gap_days integer default 180,
  p_threshold_cents integer default 500000
) returns table (
  month date,
  all_orders bigint, all_cents bigint,
  organic_orders bigint, organic_cents bigint,
  click_orders bigint, click_cents bigint,
  open_orders bigint, open_cents bigint,
  coverage_from timestamptz
)
language sql stable security definer set search_path = public as $$
with crm_touch as materialized (
  select lower(e->>'value') as email, d.first_contact_at
  from crm_deals d
  join crm_contacts ct on ct.id = d.contact_id
  cross join lateral jsonb_array_elements(ct.emails) e
  where d.first_contact_at is not null and e->>'value' is not null
),
ok as materialized (
  select o.id, o.created_at, lower(o.customer_email) as email, o.net_cents, o.staff_built, o.rep_code,
         coalesce(nullif(o.customer_name_norm, ''), o.customer_email, o.id::text) as ckey
  from shop_orders o
  where not o.test and not o.test_checkout
    and coalesce(o.financial_status, '') not in ('PENDING', 'AUTHORIZED', 'VOIDED', 'EXPIRED')
),
seq as (
  select *,
         case when created_at - lag(created_at) over (partition by ckey order by created_at)
                   > make_interval(days => p_gap_days) or lag(created_at) over (partition by ckey order by created_at) is null
              then 1 else 0 end as starts
  from ok
),
clustered as materialized (
  select *, sum(starts) over (partition by ckey order by created_at rows unbounded preceding) as purchase_no
  from seq
),
purchases as materialized (
  select ckey, purchase_no,
         max(created_at) filter (where net_cents > p_threshold_cents) as last_big_at,
         (array_agg(staff_built order by created_at))[1] as first_staff_built,
         min(email) as email
  from clustered
  group by 1, 2
  having max(net_cents) > p_threshold_cents
),
purchase_flags as materialized (
  select p.ckey, p.purchase_no,
         p.first_staff_built
           or exists (select 1 from clustered c where c.ckey = p.ckey and c.purchase_no = p.purchase_no
                        and c.rep_code and c.created_at <= p.last_big_at)
           or exists (select 1 from crm_touch t where t.email = p.email
                        and t.first_contact_at < p.last_big_at
                        and t.first_contact_at >= p.last_big_at - make_interval(days => p_gap_days))
           as sales
  from purchases p
),
orders as materialized (
  select c.id, c.created_at, c.email, c.net_cents,
         case when pf.ckey is not null then not pf.sales
              else not (c.staff_built or c.rep_code
                        or exists (select 1 from crm_touch t where t.email = c.email
                                     and t.first_contact_at < c.created_at
                                     and t.first_contact_at >= c.created_at - make_interval(days => p_gap_days)))
         end as organic
  from clustered c
  left join purchase_flags pf on pf.ckey = c.ckey and pf.purchase_no = c.purchase_no
  where c.created_at >= p_from and c.net_cents > 0
),
klav as materialized (
  select o.id,
         bool_or(e.type = 'email_click') as clicked,
         bool_or(e.type = 'email_open') as opened
  from orders o
  join engagement_events e
    on e.person_email = o.email
   and e.source = 'klaviyo'
   and e.type in ('email_click', 'email_open')
   and e.occurred_at < o.created_at
   and e.occurred_at >= o.created_at - make_interval(days => p_window_days)
  where o.email is not null
  group by o.id
),
classified as (
  select o.*, coalesce(k.clicked, false) as clicked, coalesce(k.opened, false) as opened
  from orders o
  left join klav k on k.id = o.id
)
select (date_trunc('month', created_at at time zone 'America/Los_Angeles'))::date as month,
       count(*) as all_orders,
       sum(net_cents)::bigint as all_cents,
       count(*) filter (where organic) as organic_orders,
       coalesce(sum(net_cents) filter (where organic), 0)::bigint as organic_cents,
       count(*) filter (where organic and clicked) as click_orders,
       coalesce(sum(net_cents) filter (where organic and clicked), 0)::bigint as click_cents,
       count(*) filter (where organic and opened and not clicked) as open_orders,
       coalesce(sum(net_cents) filter (where organic and opened and not clicked), 0)::bigint as open_cents,
       (select min(occurred_at) from engagement_events where source = 'klaviyo' and type in ('email_click', 'email_open')) as coverage_from
from classified
group by 1
order by 1;
$$;
