-- Scope the Texts page to the rep's own line(s): sms_threads gains an
-- our-numbers filter. NULL = all threads (admin view). Dropping the old
-- 1-arg overload avoids PostgREST ambiguity.
drop function if exists public.sms_threads(int);

create or replace function public.sms_threads(p_limit int default 200, p_our_numbers text[] default null)
returns table(peer_phone text, last_at timestamptz, last_body text,
              last_direction text, awaiting_reply boolean, msg_count bigint)
language sql stable as $$
  select t.peer_phone, t.sent_at, t.body, t.direction,
         (t.direction = 'incoming'), n.cnt
  from (
    select distinct on (peer_phone) peer_phone, sent_at, body, direction
    from sms_messages
    where p_our_numbers is null or our_number = any(p_our_numbers)
    order by peer_phone, sent_at desc
  ) t
  join lateral (
    select count(*) cnt from sms_messages m
    where m.peer_phone = t.peer_phone
      and (p_our_numbers is null or m.our_number = any(p_our_numbers))
  ) n on true
  order by t.sent_at desc
  limit p_limit
$$;
