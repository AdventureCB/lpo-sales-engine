-- Recompute one deal's last_activity_at from its own + its contact's
-- activities and calls. Called on every deal upsert so a deal created AFTER
-- its contact already had activity history gets an accurate date (the bump
-- trigger only touches deals that exist when the activity lands).
create or replace function refresh_one_deal_last_activity(p_deal uuid)
returns void language sql security definer as $$
  update crm_deals set last_activity_at = (
    select max(m) from (
      select greatest(occurred_at, coalesce(done_at, occurred_at)) as m
      from crm_activities where deal_id = p_deal
      union all
      select greatest(a.occurred_at, coalesce(a.done_at, a.occurred_at))
      from crm_activities a
      where a.contact_id = (select contact_id from crm_deals where id = p_deal)
      union all
      select c.started_at
      from call_events c
      where c.deal_id = (select pipedrive_deal_id from crm_deals where id = p_deal)
    ) t
  )
  where id = p_deal;
$$;
