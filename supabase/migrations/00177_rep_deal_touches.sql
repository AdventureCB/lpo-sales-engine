-- Per-rep KPIs (Kyle 10/16): every REAL outbound touch a rep made on a deal —
-- outbound dials and answered inbound calls (call_events), and logged
-- emails/texts/calls (crm_activities by a rep actor, not scheduled, not
-- inbound/internal). Grouped per (rep, deal): first touch (cohort key), last
-- touch (staleness) and touch counts in a window (throughput).
create or replace function rep_deal_touches(p_window_start timestamptz)
returns table (rep_email text, deal_id uuid, first_touch timestamptz, last_touch timestamptz, touches_window bigint, touches_total bigint)
language sql stable security definer set search_path = public as $$
  with calls as (
    select r.email as rep_email,
           coalesce(c.crm_deal_id, d.id) as deal_id,
           c.started_at as at
    from call_events c
    join reps r on r.id = c.rep_id
    left join crm_deals d on c.crm_deal_id is null and d.pipedrive_deal_id = c.deal_id
    where (c.direction = 'outgoing' or (c.direction = 'incoming' and c.answered_at is not null))
  ),
  acts as (
    select lower(a.actor) as rep_email, a.deal_id, a.occurred_at as at
    from crm_activities a
    where a.actor like '%@%'
      and a.due_at is null
      and a.deal_id is not null
      and (
        a.type in ('sms', 'call', 'meeting')
        or (a.type = 'email' and coalesce(a.meta->>'direction', 'outbound') not in ('inbound', 'internal'))
      )
  ),
  touches as (select * from calls where deal_id is not null union all select * from acts)
  select rep_email, deal_id,
         min(at) as first_touch, max(at) as last_touch,
         count(*) filter (where at >= p_window_start) as touches_window,
         count(*) as touches_total
  from touches
  group by rep_email, deal_id;
$$;
