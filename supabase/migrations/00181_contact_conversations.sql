-- Person-level conversation history (Kyle 10/26: "Cold Wake up" texted people
-- we've talked to). crm_deals.contact_count only counts calls LINKED to that
-- deal; calls from other lines / unlinked call rows and inbound texts were
-- invisible. Match by phone (last 10 digits) across ALL call_events and
-- sms_messages.
create or replace function contact_conversations(p_contact_ids uuid[])
returns table (contact_id uuid, conv_calls bigint, inbound_texts bigint)
language sql stable security definer set search_path = public as $$
  with ph as (
    select c.id as contact_id, right(regexp_replace(coalesce(p->>'e164', p->>'value', ''), '\D', '', 'g'), 10) as d10
    from crm_contacts c cross join lateral jsonb_array_elements(coalesce(c.phones, '[]'::jsonb)) p
    where c.id = any (p_contact_ids)
  ),
  ph10 as (select distinct contact_id, d10 from ph where length(d10) = 10),
  calls as (
    select ph10.contact_id, count(distinct ce.id) as n
    from ph10
    join call_events ce on ce.classification = 'conversation' or ce.disposition = 'connected'
    cross join lateral jsonb_array_elements_text(coalesce(ce.raw->'data'->'object'->'participants', ce.raw->'participants', '[]'::jsonb)) part
    where right(regexp_replace(part, '\D', '', 'g'), 10) = ph10.d10
    group by 1
  ),
  texts as (
    select ph10.contact_id, count(*) as n
    from ph10 join sms_messages m on m.direction = 'incoming' and right(regexp_replace(m.peer_phone, '\D', '', 'g'), 10) = ph10.d10
    group by 1
  )
  select c.cid, coalesce(calls.n, 0), coalesce(texts.n, 0)
  from unnest(p_contact_ids) as c(cid)
  left join calls on calls.contact_id = c.cid
  left join texts on texts.contact_id = c.cid;
$$;
