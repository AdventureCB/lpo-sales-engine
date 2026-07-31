-- Every phone number attached to a journey customer (order phone + CRM
-- contact phones) — the target list for the Quo call-history backfill.
create or replace function journey_backfill_phones()
returns table (phone text)
language sql stable security definer as $$
  select distinct ph from (
    select o.customer_phone as ph
    from sales_orders o
    where o.journey_id is not null and o.customer_phone is not null
    union
    select p->>'e164'
    from sales_orders o
    join crm_contacts ct
      on ct.emails @> jsonb_build_array(jsonb_build_object('value', o.customer_email)),
      jsonb_array_elements(ct.phones) p
    where o.journey_id is not null
      and o.customer_email is not null
      and p->>'e164' is not null
  ) x
  where ph like '+%'
  order by ph;
$$;
