-- journey_talk_times took ~9s (scoreboard analytics 500 via the ~8s API
-- statement timeout): it scanned EVERY call_event, extracting the peer from
-- raw jsonb per row with a correlated not-in against our own numbers.
-- Flip the join: probe call_events by each journey phone with a GIN
-- containment index on the participants array (the Telnyx pipeline writes
-- the same raw.data.object.participants shape as Quo, so one path covers
-- both eras). No "ours" filter needed — we match the customer phone directly.

create index if not exists idx_call_events_participants
  on call_events using gin ((raw->'data'->'object'->'participants') jsonb_path_ops);

create or replace function public.journey_talk_times()
returns table(journey_id uuid, talk_to_deposit_s bigint, talk_to_confirm_s bigint)
language sql
stable security definer
as $function$
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
  left join call_events ca
    on jp.phone is not null
   and (ca.classification = 'conversation' or ca.disposition = 'confirmation')
   and ca.duration_s > 0
   and ca.raw->'data'->'object'->'participants' @> jsonb_build_array(jp.phone)
  group by jp.id;
$function$;

-- The dominant cost was actually 150+ sequential scans of crm_contacts for
-- the email containment probe (one per journey). 8.9s -> 0.4s with this.
create index if not exists idx_crm_contacts_emails_gin
  on crm_contacts using gin (emails jsonb_path_ops);
