-- Ops ↔ Sales Engine integration (contract: docs/ops-integration.md).
-- Ops (lone-peak-ops.vercel.app, Neon) pushes signed events about quotes
-- (created/updated, customer activity, paid, emails, production) to
-- /api/webhooks/ops; a nightly pull reconciles misses. This is the Sales
-- Engine side: the quote mirror, the event ledger, the "Quote Created" intake
-- engine for quotes with no deal, and the reconcile cron.

create table if not exists ops_quotes (
  quote_id        text primary key,            -- Ops' stable id
  quote_number    text,                        -- LPQ-0201
  crm_deal_id     uuid references crm_deals(id) on delete set null,
  contact_id      uuid references crm_contacts(id) on delete set null,
  customer        jsonb,                       -- {name, first_name, last_name, email, phone} as last sent
  link            text,                        -- customer-facing quote URL
  total_cents     bigint,
  deposit_cents   bigint,
  currency        text default 'USD',
  status          text,                        -- draft|sent|viewed|accepted|paid|expired|void
  origin          text,                        -- rep|builder
  created_by      text,                        -- Ops user email or "builder"
  truck           text,
  summary         text,
  version         int,
  paid_cents      bigint not null default 0,
  last_paid_at    timestamptz,
  view_count      int not null default 0,
  first_viewed_at timestamptz,
  last_viewed_at  timestamptz,
  production_status text,
  production_label  text,
  production_eta    date,
  quote_created_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_ops_quotes_deal on ops_quotes (crm_deal_id);
alter table ops_quotes enable row level security;

create table if not exists ops_events (
  event_id     text primary key,
  type         text not null,
  quote_id     text,
  occurred_at  timestamptz not null,
  crm_deal_id  uuid,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  via          text not null default 'webhook',   -- webhook | pull
  result       jsonb,                             -- what the engine did (deal, timeline row, notification)
  notify_email text,                              -- set when the owner should see this in the bell
  notify_title text
);
create index if not exists idx_ops_events_notify on ops_events (notify_email, received_at desc);
create index if not exists idx_ops_events_quote on ops_events (quote_id, occurred_at);
alter table ops_events enable row level security;

-- "Quote Created" intake engine: a quote with no matching deal (rep started it
-- in Ops directly, or the website 3D builder made one after a self-serve
-- deposit) becomes a deal here. paid_stage_id = where ANY quote.paid lands
-- (Confirmation pipeline → Deposit Placed, Kyle 11/5); reps review from there.
alter table intake_sources drop constraint if exists intake_sources_adapter_check;
alter table intake_sources add constraint intake_sources_adapter_check
  check (adapter = any (array[
    'shopify_abandoned_checkout','typeform','klaviyo_metric','klaviyo_list',
    'klaviyo_segment','webhook','hotlist_recovery','booking','trailhub_raffle','web_form','trailhub_interest','ops_quote'
  ]));

insert into intake_sources (label, adapter, enabled, config)
select 'Quote Created', 'ops_quote', true, jsonb_build_object(
  'source_name', 'Quote Created',
  'title_template', 'Quote Created - {name}',
  'on_existing_open', 'note',
  'on_existing_closed', 'reopen_assign',
  'write_pipedrive', false,
  'notify_owner', true,
  'crm_stage_id', (select config->>'crm_stage_id' from intake_sources where adapter = 'trailhub_raffle' limit 1),
  'owner_pool', coalesce((select config->'owner_pool' from intake_sources where adapter = 'trailhub_raffle' limit 1), '[]'::jsonb),
  'paid_stage_id', (
    select s.id from crm_stages s join crm_pipelines p on p.id = s.pipeline_id
    where s.name = 'Deposit Placed' and p.name ilike 'Confirmation%' limit 1
  )
)
where not exists (select 1 from intake_sources where adapter = 'ops_quote');

-- Nightly reconcile against Ops' pull endpoint: 10:00 UTC = 2/3am PT.
select cron.schedule(
  'ops-reconcile-nightly',
  '0 10 * * *',
  $$select net.http_get(url := 'https://lpo-sales-engine.vercel.app/api/cron/ops-reconcile', headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')), timeout_milliseconds := 115000)$$
);
