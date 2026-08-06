-- Batch call stats for the CRM list: dials + conversations per deal, matched
-- by linked deal id OR any of the contact's phones (same rule as the
-- single-deal deal_call_stats). call_events is small, so the cross-match is cheap.
create or replace function deals_call_stats(p_deals uuid[])
returns table(deal_id uuid, dials bigint, conversations bigint)
language sql stable as $$
  with d as (
    select cd.id, cd.pipedrive_deal_id,
      array(
        select ph->>'e164'
        from crm_contacts c, jsonb_array_elements(c.phones) ph
        where c.id = cd.contact_id and ph->>'e164' is not null
      ) as phones
    from crm_deals cd
    where cd.id = any(p_deals)
  ),
  m as (
    select d.id as deal_id, ce.direction, ce.classification, ce.disposition
    from d
    join call_events ce on (
      (d.pipedrive_deal_id is not null and ce.deal_id = d.pipedrive_deal_id)
      or (ce.raw is not null and exists (
        select 1 from jsonb_array_elements_text(ce.raw->'data'->'object'->'participants') pt
        where pt = any(d.phones)
      ))
    )
  )
  select d.id,
    count(m.*) filter (where m.direction = 'outgoing') as dials,
    count(m.*) filter (
      where m.direction = 'outgoing'
        and (m.classification = 'conversation' or m.disposition in ('connected', 'confirmation'))
    ) as conversations
  from d
  left join m on m.deal_id = d.id
  group by d.id;
$$;
