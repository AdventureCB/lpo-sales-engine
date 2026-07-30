-- Pipedrive's v2 deals API returns no last-activity field, and Quo logs
-- calls/notes on the person rather than the deal — so a deal's last touch is
-- computed here: activities linked to the deal, activities on its contact,
-- and calls captured in call_events. Run after import and on demand.
create or replace function refresh_deal_last_activity()
returns void
language sql
security definer
as $$
  with touches as (
    select deal_id as id, max(occurred_at) as m
    from crm_activities where deal_id is not null group by deal_id
    union all
    select d.id, max(a.occurred_at)
    from crm_activities a join crm_deals d on d.contact_id = a.contact_id
    where a.contact_id is not null group by d.id
    union all
    select d.id, max(c.started_at)
    from call_events c join crm_deals d on d.pipedrive_deal_id = c.deal_id
    where c.deal_id is not null group by d.id
  ),
  last as (select id, max(m) as max_at from touches group by id)
  update crm_deals set last_activity_at = last.max_at
  from last
  where crm_deals.id = last.id
    and crm_deals.last_activity_at is distinct from last.max_at;
$$;
