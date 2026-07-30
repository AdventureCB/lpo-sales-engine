-- Scoreboard analytics: dials↔talk correlation, SMS response rate, and
-- lifetime talk-time leaders per contact.

-- Response-rate pairing needs the counterparty number on each text; the
-- webhook carries it but it was never persisted. Go-forward only.
alter table message_events add column peer_phone text;
create index idx_message_events_peer on message_events (peer_phone, sent_at);

-- Phone → contact-name lookups against the phones jsonb.
create index idx_crm_contacts_phones on crm_contacts using gin (phones jsonb_path_ops);

-- Per rep per day: outgoing dials + conversation talk seconds (same talk-time
-- definition as the scoreboard tiles: summed duration on conversation calls).
create or replace function scoreboard_dials_talk(p_days int default 60)
returns table (day date, rep text, dials bigint, talk_s bigint)
language sql stable security definer as $$
  select (c.started_at at time zone 'America/Los_Angeles')::date as day,
         r.name as rep,
         count(*) filter (where c.direction = 'outgoing') as dials,
         coalesce(sum(c.duration_s) filter (where c.classification = 'conversation'), 0)::bigint as talk_s
  from call_events c
  join reps r on r.id = c.rep_id
  where c.started_at >= now() - make_interval(days => p_days)
  group by 1, 2
  order by 1;
$$;

-- Weekly outbound texts and how many drew an inbound reply from the same
-- number within 48 hours. Rows without peer_phone (pre-tracking) are excluded.
create or replace function sms_response_rate(p_days int default 120)
returns table (week date, rep text, outbound bigint, replied bigint)
language sql stable security definer as $$
  select (date_trunc('week', m.sent_at at time zone 'America/Los_Angeles'))::date as week,
         coalesce(r.name, 'Team') as rep,
         count(*) as outbound,
         count(*) filter (where exists (
           select 1 from message_events i
           where i.direction = 'incoming'
             and i.peer_phone = m.peer_phone
             and i.sent_at > m.sent_at
             and i.sent_at <= m.sent_at + interval '48 hours'
         )) as replied
  from message_events m
  left join reps r on r.id = m.rep_id
  where m.direction = 'outgoing'
    and m.peer_phone is not null
    and m.sent_at >= now() - make_interval(days => p_days)
  group by 1, 2
  order by 1;
$$;

-- Contacts whose lifetime conversation time crosses a threshold (default 15
-- min), attributed to the rep who has the most talk time with them. Peer =
-- the participant that isn't one of our Quo lines.
create or replace function talk_time_leaders(p_min_s int default 900)
returns table (rep text, peer_phone text, contact_name text, calls bigint, talk_s bigint, last_call timestamptz)
language sql stable security definer as $$
  with peers as (
    select c.rep_id, c.duration_s, c.started_at,
      (select pt from jsonb_array_elements_text(c.raw->'data'->'object'->'participants') pt
        where pt not in (select phone_number from quo_lines where phone_number is not null)
        limit 1) as peer
    from call_events c
    where c.classification = 'conversation' and c.duration_s > 0
      and c.rep_id is not null and c.raw is not null
  ),
  tot as (
    select peer, count(*) as calls, sum(duration_s)::bigint as talk_s, max(started_at) as last_call
    from peers where peer is not null
    group by peer
    having sum(duration_s) >= p_min_s
  ),
  lead_rep as (
    select distinct on (peer) peer, rep_id
    from (select peer, rep_id, sum(duration_s) as s from peers where peer is not null group by 1, 2) x
    order by peer, s desc
  )
  select r.name, tot.peer, nm.name, tot.calls, tot.talk_s, tot.last_call
  from tot
  join lead_rep using (peer)
  join reps r on r.id = lead_rep.rep_id
  left join lateral (
    select ct.name from crm_contacts ct
    where ct.phones @> jsonb_build_array(jsonb_build_object('e164', tot.peer))
    limit 1
  ) nm on true
  order by tot.talk_s desc;
$$;
