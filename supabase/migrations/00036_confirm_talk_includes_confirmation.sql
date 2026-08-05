-- Talk-to-confirmation includes the confirmation call itself: the deposit is
-- the initial sale, the confirmation is the execution of the deal.
--  1. Confirmation-dispo calls count even without a transcript classification.
--  2. A confirmation call within 24h AFTER confirmed_at still counts (the
--     order sometimes lands before the call wraps / is dispositioned).
--  3. Peer detection also excludes rep Telnyx numbers (was Quo-lines only —
--     Telnyx-era calls could match our own number as the "customer").
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
  ours as (
    select phone_number as num from quo_lines where phone_number is not null
    union
    select telnyx_number from reps where telnyx_number is not null
  ),
  calls as (
    select (select pt from jsonb_array_elements_text(c.raw->'data'->'object'->'participants') pt
            where pt not in (select num from ours)
            limit 1) as peer,
           c.duration_s, c.started_at, c.disposition
    from call_events c
    where (c.classification = 'conversation' or c.disposition = 'confirmation')
      and c.duration_s > 0 and c.raw is not null
  )
  select jp.id,
    coalesce(sum(ca.duration_s) filter (
      where jp.deposit_started_at is not null and ca.started_at < jp.deposit_started_at
        and ca.disposition is distinct from 'confirmation'
    ), 0)::bigint as talk_to_deposit_s,
    coalesce(sum(ca.duration_s) filter (
      where jp.confirmed_at is not null
        and (jp.deposit_started_at is null or ca.started_at >= jp.deposit_started_at)
        and (
          ca.started_at <= jp.confirmed_at
          or (ca.disposition = 'confirmation'
              and ca.started_at <= jp.confirmed_at + interval '24 hours')
        )
    ), 0)::bigint as talk_to_confirm_s
  from jphones jp
  left join calls ca on ca.peer = jp.phone
  group by jp.id;
$$;
