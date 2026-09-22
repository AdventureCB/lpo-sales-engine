-- Booking intake engine (Kyle 9/22): online bookings run through an intake
-- engine so admins control — from Settings → Intake — the round-robin pool,
-- deal source, pipeline/stage, title template and existing-deal behavior.
-- The owner is ALWAYS the guide who was booked (it's their calendar); the
-- pool only decides who the round-robin link (/book) rotates over.
alter table intake_sources drop constraint if exists intake_sources_adapter_check;
alter table intake_sources add constraint intake_sources_adapter_check
  check (adapter = any (array[
    'shopify_abandoned_checkout','typeform','klaviyo_metric','klaviyo_list',
    'klaviyo_segment','webhook','hotlist_recovery','booking'
  ]));

-- Seed ENABLED with today's behavior (source "Gravel Guide Call", Prospecting
-- intake stage, every bookable guide in the pool) so nothing changes until an
-- admin edits it.
insert into intake_sources (label, adapter, enabled, config)
select 'Gravel Guide Booking', 'booking', true, jsonb_build_object(
  'source_name', 'Gravel Guide Call',
  'title_template', 'Scheduled Call - {name}',
  'on_existing_open', 'note',
  'on_existing_closed', 'reopen_assign',
  'write_pipedrive', false,
  'notify_owner', false,
  'crm_stage_id', (
    select s.id from crm_stages s join crm_pipelines p on p.id = s.pipeline_id
    where s.name ilike '%intake%' and p.name ilike '%prospect%' limit 1
  ),
  'owner_pool', coalesce((
    select jsonb_agg(jsonb_build_object('pipedrive_id', r.pipedrive_user_id, 'name', r.name, 'enabled', true) order by r.sort_order, r.name)
    from reps r where r.active and r.booking_enabled and r.pipedrive_user_id is not null
  ), '[]'::jsonb)
)
where not exists (select 1 from intake_sources where adapter = 'booking');
