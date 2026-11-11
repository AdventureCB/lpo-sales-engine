-- campaign_replies: inbound EMAIL replies are stored by Gmail sync on the
-- contact only (deal_id null), so the deal_id join never matched an email
-- reply — Colton's "No Phone # - Email Drip" sent step 2 to Scott Marrs after
-- he replied to step 1 (11/11). Match the deal OR the contact.
create or replace function campaign_replies(p_owner text default null, p_active_only boolean default false)
returns table (
  campaign_id uuid, enrollment_id uuid, deal_id uuid, contact_id uuid, owner_email text,
  status text, last_send_at timestamptz, first_reply_at timestamptz, last_reply_at timestamptz, last_reply_text text
)
language sql stable security definer set search_path = public as $$
  with sent as (
    select e.id as enrollment_id, e.campaign_id, e.deal_id, e.contact_id, e.owner_email, e.status, e.last_send_at, min(s.sent_at) as first_sent
    from campaign_enrollments e
    join campaign_sends s on s.enrollment_id = e.id and s.status = 'sent'
    where (p_owner is null or e.owner_email = p_owner)
      and (not p_active_only or e.status = 'active')
    group by e.id
  ),
  phones as (
    select distinct sent.enrollment_id, p.ph
    from sent
    cross join lateral (
      select s.to_address as ph from campaign_sends s where s.enrollment_id = sent.enrollment_id and s.channel = 'sms'
      union
      select coalesce(x->>'e164', x->>'value') from crm_contacts c, jsonb_array_elements(coalesce(c.phones, '[]'::jsonb)) x where c.id = sent.contact_id
    ) p
    where p.ph is not null and p.ph <> ''
  ),
  replies as (
    select sent.enrollment_id, m.sent_at as at, coalesce(m.body, '') as txt
    from sent
    join phones on phones.enrollment_id = sent.enrollment_id
    join sms_messages m on m.direction = 'incoming' and m.peer_phone = phones.ph and m.sent_at > sent.first_sent
    union all
    select sent.enrollment_id, a.occurred_at, coalesce(a.subject, '') || ' ' || coalesce(a.body, '')
    from sent
    join crm_activities a on (a.deal_id = sent.deal_id or a.contact_id = sent.contact_id) and a.type = 'email' and a.meta->>'direction' = 'inbound' and a.occurred_at > sent.first_sent
  )
  select sent.campaign_id, sent.enrollment_id, sent.deal_id, sent.contact_id, sent.owner_email, sent.status, sent.last_send_at,
         min(r.at), max(r.at), (array_agg(r.txt order by r.at desc))[1]
  from sent
  join replies r on r.enrollment_id = sent.enrollment_id
  group by sent.campaign_id, sent.enrollment_id, sent.deal_id, sent.contact_id, sent.owner_email, sent.status, sent.last_send_at;
$$;
