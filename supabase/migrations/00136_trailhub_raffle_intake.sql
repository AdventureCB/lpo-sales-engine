-- Trailhub raffle intake (Kyle 9/22): drawing entrants from the Trailhub app
-- (SEPARATE Supabase project babbgaziiyjfaqjsaxgd, read cross-project via its
-- service-role key in Vercel) become leads through an intake engine.
alter table intake_sources drop constraint if exists intake_sources_adapter_check;
alter table intake_sources add constraint intake_sources_adapter_check
  check (adapter = any (array[
    'shopify_abandoned_checkout','typeform','klaviyo_metric','klaviyo_list',
    'klaviyo_segment','webhook','hotlist_recovery','booking','trailhub_raffle'
  ]));

-- Seeded DISABLED (Kyle flips it on). Pool = the same four guides as the
-- booking engine; source "Trailhub Raffle"; Prospecting intake stage.
insert into intake_sources (label, adapter, enabled, config)
select 'Trailhub Raffle', 'trailhub_raffle', false, jsonb_build_object(
  'source_name', 'Trailhub Raffle',
  'title_template', 'Trailhub Raffle - {name}',
  'on_existing_open', 'note',
  'on_existing_closed', 'reopen_assign',
  'write_pipedrive', false,
  'notify_owner', true,
  'crm_stage_id', (
    select s.id from crm_stages s join crm_pipelines p on p.id = s.pipeline_id
    where s.name ilike '%intake%' and p.name ilike '%prospect%' limit 1
  ),
  'owner_pool', coalesce((select config->'owner_pool' from intake_sources where adapter = 'booking' limit 1), '[]'::jsonb)
)
where not exists (select 1 from intake_sources where adapter = 'trailhub_raffle');

-- Twice daily: 15:00 / 23:00 UTC = 8am / 4pm PDT (7am / 3pm PST).
select cron.schedule(
  'trailhub-raffle-2x-daily',
  '0 15,23 * * *',
  $$select net.http_get(url := 'https://lpo-sales-engine.vercel.app/api/cron/trailhub-raffle', headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')), timeout_milliseconds := 115000)$$
);
