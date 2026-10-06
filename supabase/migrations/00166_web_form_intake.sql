-- Website forms → Intake Engine. One engine per form, matched on
-- config.form_key by POST /api/webhooks/web-form. Seeds the Demo Request
-- form: Prospecting pool (Logan off, like the other engines), intake stage,
-- source "Demo Request". Klaviyo list is picked in Settings.
alter table intake_sources drop constraint if exists intake_sources_adapter_check;
alter table intake_sources add constraint intake_sources_adapter_check check (adapter = any (array[
  'shopify_abandoned_checkout','typeform','klaviyo_metric','klaviyo_list','klaviyo_segment','webhook','hotlist_recovery','booking','trailhub_raffle','web_form'
]));

insert into intake_sources (label, adapter, enabled, config)
select 'Demo Request', 'web_form', true, jsonb_build_object(
  'form_key', 'demo-request',
  'source_name', 'Demo Request',
  'title_template', 'Demo Request - {name}',
  'crm_stage_id', '56dcd0bd-9a30-43d4-bcca-80a5aaba1eb5',
  'on_existing_open', 'note',
  'on_existing_closed', 'reopen_assign',
  'notify_owner', true,
  'write_pipedrive', false,
  'owner_pool', (select config->'owner_pool' from intake_sources where adapter = 'trailhub_raffle' limit 1)
)
where not exists (select 1 from intake_sources where adapter = 'web_form' and config->>'form_key' = 'demo-request');

insert into deal_sources (name) values ('Demo Request') on conflict (name) do nothing;

create index if not exists idx_intake_sources_form_key on intake_sources ((config->>'form_key')) where adapter = 'web_form';
