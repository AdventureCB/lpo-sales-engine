-- Per-deal call counters: match calls by linked deal OR any contact phone
-- (webhook-logged calls often carry only the phone, not the deal id).
create or replace function deal_call_stats(p_phones text[], p_deal_id bigint default null)
returns table(dials bigint, answered bigint, talk_s bigint, inbound bigint)
language sql stable as $$
  with matched as (
    select distinct on (c.id) c.*
    from call_events c
    where (p_deal_id is not null and c.deal_id = p_deal_id)
       or (
         c.raw is not null and exists (
           select 1
           from jsonb_array_elements_text(c.raw->'data'->'object'->'participants') pt
           where pt = any(p_phones)
         )
       )
  )
  select
    count(*) filter (where direction = 'outgoing') as dials,
    count(*) filter (
      where direction = 'outgoing'
        and (classification = 'conversation' or disposition in ('connected', 'confirmation'))
    ) as answered,
    coalesce(sum(duration_s) filter (
      where classification = 'conversation'
         or disposition in ('connected', 'confirmation')
         or (direction = 'incoming' and answered_at is not null)
    ), 0)::bigint as talk_s,
    count(*) filter (where direction = 'incoming') as inbound
  from matched;
$$;
