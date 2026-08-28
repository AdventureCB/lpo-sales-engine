-- Call → deal linking used to happen ONLY when the rep completed the
-- disposition. A crash / closed window between hangup and disposition
-- (rampant on 8/27-28) left the call in call_events — full transcript and
-- all — with no deal attached, so it never showed on the deal page and
-- never fed the AI profiler. This back-links orphaned OUTBOUND calls to a
-- deal by the customer's phone, exactly like contacts_by_phones does, but
-- PREFERRING the deal owned by the rep who placed the call (the safe pick
-- when a contact has more than one deal). Zero tokens; runs from the
-- 15-min hot-list cron so a stranded call self-heals within minutes.

create or replace function public.backlink_orphan_calls(p_since timestamptz default now() - interval '45 days')
returns integer
language plpgsql
as $function$
declare
  n integer;
begin
  create temp table _ours on commit drop as
    select right(regexp_replace(num, '\D', '', 'g'), 10) as d10 from (
      select telnyx_number as num from reps where telnyx_number is not null
      union select quo_phone_number from reps where quo_phone_number is not null
      union select phone_number from quo_lines where phone_number is not null
    ) x where num is not null;

  create temp table _orphans on commit drop as
    select ce.id, ce.rep_id,
      right(regexp_replace(
        (select pt from jsonb_array_elements_text(ce.raw->'data'->'object'->'participants') pt
         where right(regexp_replace(pt, '\D', '', 'g'), 10) not in (select d10 from _ours)
         limit 1), '\D', '', 'g'), 10) as peer10
    from call_events ce
    where ce.crm_deal_id is null
      and ce.deal_id is null
      and ce.direction = 'outgoing'
      and ce.rep_id is not null
      and ce.started_at >= p_since
      and ce.raw ? 'data';

  create temp table _linked on commit drop as
    select o.id as call_id, dd.deal_id, dd.pd_id
    from _orphans o
    join lateral (
      -- Best deal for the customer's contact: prefer one OWNED by the rep
      -- who called, then any open deal, then most-recent — never guess
      -- across contacts.
      select d.id as deal_id, d.pipedrive_deal_id as pd_id
      from crm_contacts c
      join crm_deals d on d.contact_id = c.id
      join reps r on r.id = o.rep_id
      where o.peer10 is not null
        and public.contact_phone_set(c.phones) @> array[o.peer10]
      order by
        (d.owner_pipedrive_id = r.pipedrive_user_id) desc,
        (d.status = 'open') desc,
        d.updated_at desc
      limit 1
    ) dd on true;

  update call_events ce
  set crm_deal_id = l.deal_id,
      -- deal_id stays the REAL Pipedrive id only (synthetic ≥900M are
      -- native deals — crm_deal_id already covers them).
      deal_id = case when l.pd_id < 900000000 then l.pd_id else ce.deal_id end
  from _linked l
  where ce.id = l.call_id;
  get diagnostics n = row_count;
  return n;
end;
$function$;

-- Housekeeping: 00110 added a 3-arg ai_refresh_candidates but left the
-- 00108 2-arg version, making unqualified calls ambiguous. Drop the old one.
drop function if exists public.ai_refresh_candidates(integer, integer);
