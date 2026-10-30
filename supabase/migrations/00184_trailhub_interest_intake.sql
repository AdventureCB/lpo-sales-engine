-- Trailhub product-interest intake (Kyle 10/30): people who sign up in the
-- Trailhub app to hear about an upcoming product (new camper first) become
-- leads. Same read-only pull model as the raffle: view public.crm_interest_leads
-- in the Trailhub project, read as crm_reader over the pooler (TRAILHUB_DB_URL).
alter table intake_sources drop constraint if exists intake_sources_adapter_check;
alter table intake_sources add constraint intake_sources_adapter_check
  check (adapter = any (array[
    'shopify_abandoned_checkout','typeform','klaviyo_metric','klaviyo_list',
    'klaviyo_segment','webhook','hotlist_recovery','booking','trailhub_raffle','web_form','trailhub_interest'
  ]));

-- Seeded DISABLED; pool + stage copied from the raffle engine. A second list
-- signup by the same person is a note on their deal (on_existing_open=note).
insert into intake_sources (label, adapter, enabled, config)
select 'Trailhub Interest', 'trailhub_interest', false, jsonb_build_object(
  'source_name', 'Trailhub Interest',
  'title_template', 'Trailhub Interest - {name}',
  'on_existing_open', 'note',
  'on_existing_closed', 'reopen_assign',
  'write_pipedrive', false,
  'notify_owner', true,
  'crm_stage_id', (select config->>'crm_stage_id' from intake_sources where adapter = 'trailhub_raffle' limit 1),
  'owner_pool', coalesce((select config->'owner_pool' from intake_sources where adapter = 'trailhub_raffle' limit 1), '[]'::jsonb)
)
where not exists (select 1 from intake_sources where adapter = 'trailhub_interest');

-- Hourly at :20 — interest signups are warm ("tell me when the new camper is
-- ready"), so they shouldn't wait for the raffle's twice-daily cadence.
select cron.schedule(
  'trailhub-interest-hourly',
  '20 * * * *',
  $$select net.http_get(url := 'https://lpo-sales-engine.vercel.app/api/cron/trailhub-interest', headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')), timeout_milliseconds := 115000)$$
);
