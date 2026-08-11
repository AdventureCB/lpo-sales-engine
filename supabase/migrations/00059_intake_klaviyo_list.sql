-- Klaviyo-list intake adapter (Synchrony financing applicants et al):
-- watches a Klaviyo list for new members and feeds them to the Intake Engine.
alter table intake_sources drop constraint if exists intake_sources_adapter_check;
alter table intake_sources add constraint intake_sources_adapter_check
  check (adapter in ('shopify_abandoned_checkout', 'typeform', 'klaviyo_metric', 'klaviyo_list', 'webhook'));

insert into intake_sources (channel_id, label, adapter, enabled, config)
select null, 'Synchrony Financing', 'klaviyo_list', false, '{
  "klaviyo_list_name": "Synchrony Applicants",
  "title_template": "{label} - {name}",
  "title_marker": "⚡",
  "enrich_phone": false,
  "on_existing_open": "note",
  "on_existing_closed": "reopen_assign",
  "source_name": "Synchrony Financing",
  "write_pipedrive": true,
  "pipedrive_stage_id": 44,
  "fallback_owner_pipedrive_id": 23851101,
  "owner_pool": [
    {"pipedrive_id": 24081760, "name": "Parker", "enabled": true},
    {"pipedrive_id": 24391245, "name": "Jackson", "enabled": true}
  ]
}'::jsonb
where not exists (select 1 from intake_sources where adapter = 'klaviyo_list');
