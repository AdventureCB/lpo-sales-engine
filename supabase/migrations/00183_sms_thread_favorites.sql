-- Texts page (reps 10/27): (1) the list orders by the most recent RECEIVED
-- text, so the thread list reads like an inbox — sms_threads gains
-- last_inbound_at; (2) per-user favorites so reps can pin ongoing
-- conversations and get back to them from a ⭐ tab.
create table if not exists sms_thread_favorites (
  user_email text not null,
  peer_phone text not null,
  created_at timestamptz not null default now(),
  primary key (user_email, peer_phone)
);
alter table sms_thread_favorites enable row level security;

drop function if exists public.sms_threads(int, text[]);

create or replace function public.sms_threads(p_limit int default 200, p_our_numbers text[] default null)
returns table(peer_phone text, last_at timestamptz, last_body text,
              last_direction text, awaiting_reply boolean, msg_count bigint, last_inbound_at timestamptz)
language sql stable as $$
  select t.peer_phone, t.sent_at, t.body, t.direction,
         (t.direction = 'incoming'), n.cnt, n.last_in
  from (
    select distinct on (peer_phone) peer_phone, sent_at, body, direction
    from sms_messages
    where p_our_numbers is null or our_number = any(p_our_numbers)
    order by peer_phone, sent_at desc
  ) t
  join lateral (
    select count(*) cnt, max(m.sent_at) filter (where m.direction = 'incoming') last_in
    from sms_messages m
    where m.peer_phone = t.peer_phone
      and (p_our_numbers is null or m.our_number = any(p_our_numbers))
  ) n on true
  order by t.sent_at desc
  limit p_limit
$$;
