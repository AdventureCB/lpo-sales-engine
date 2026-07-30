-- Phase 4 journey engine support.

-- Product-id → type map (webhook line items carry no product_type). Seeded
-- from the live catalog; Merch is excluded from eligible subtotals, Deposit
-- marks deposit orders.
create table shopify_products (
  product_id bigint primary key,
  title text not null,
  product_type text not null default '',
  updated_at timestamptz not null default now()
);
alter table shopify_products enable row level security;

-- Talk time per journey, from Quo conversations with the journey customer's
-- phone(s): before the deposit (talk-to-deposit) and from deposit through
-- confirmation (talk-to-confirm; for walk-ins everything before confirmation).
create or replace function journey_talk_times()
returns table (journey_id uuid, talk_to_deposit_s bigint, talk_to_confirm_s bigint)
language sql stable security definer as $$
  with jn as (
    select j.id, j.deposit_started_at, j.confirmed_at,
      (select o.customer_email from sales_orders o
        where o.journey_id = j.id and o.customer_email is not null
        order by o.order_created_at limit 1) as email,
      (select o.customer_phone from sales_orders o
        where o.journey_id = j.id and o.customer_phone is not null
        order by o.order_created_at limit 1) as phone
    from sales_journeys j
  ),
  jphones as (
    select distinct jn.id, jn.deposit_started_at, jn.confirmed_at, p.phone
    from jn
    left join lateral (
      select jn.phone as phone where jn.phone is not null
      union
      select ph->>'e164'
      from crm_contacts ct, jsonb_array_elements(ct.phones) ph
      where jn.email is not null
        and ct.emails @> jsonb_build_array(jsonb_build_object('value', jn.email))
        and ph->>'e164' is not null
    ) p on true
  ),
  calls as (
    select (select pt from jsonb_array_elements_text(c.raw->'data'->'object'->'participants') pt
            where pt not in (select phone_number from quo_lines where phone_number is not null)
            limit 1) as peer,
           c.duration_s, c.started_at
    from call_events c
    where c.classification = 'conversation' and c.duration_s > 0 and c.raw is not null
  )
  select jp.id,
    coalesce(sum(ca.duration_s) filter (
      where jp.deposit_started_at is not null and ca.started_at < jp.deposit_started_at
    ), 0)::bigint as talk_to_deposit_s,
    coalesce(sum(ca.duration_s) filter (
      where jp.confirmed_at is not null
        and ca.started_at <= jp.confirmed_at
        and (jp.deposit_started_at is null or ca.started_at >= jp.deposit_started_at)
    ), 0)::bigint as talk_to_confirm_s
  from jphones jp
  left join calls ca on ca.peer = jp.phone
  group by jp.id;
$$;
