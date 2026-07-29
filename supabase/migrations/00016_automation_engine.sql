-- CRM-2: automation engine event queue. Writers (mirror, webhooks, signal
-- ingestion) enqueue events; a per-minute cron matches them against enabled
-- crm_automations and executes actions. At-least-once with idempotent
-- actions; every execution logged to crm_automation_runs.

create table crm_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,       -- deal_created | deal_stage_changed | signal_received | inbound_sms | hot_flag_created
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index idx_crm_events_unprocessed on crm_events (created_at) where processed_at is null;

alter table crm_events enable row level security;

-- Per-minute engine tick (fast no-op when queue is empty).
select cron.schedule(
  'crm-automations-tick',
  '* * * * *',
  $$
  select net.http_get(
    url := 'https://lpo-sales-engine.vercel.app/api/cron/automations',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 55000
  )
  $$
);

-- Flagship example (disabled until reviewed): replaces the broken Zap.
insert into crm_automations (name, enabled, trigger, conditions, actions, created_by)
values (
  '3D Builder save → create deal (replaces Zap)',
  false,
  '{"type": "signal_received", "signal_type": "builder_save"}',
  '[]',
  '[{"type": "create_deal", "title_template": "Saved Build - {{contact.name}}", "pipedrive_stage_id": 44, "enrich_phone_from_klaviyo": true}]',
  'system'
);
