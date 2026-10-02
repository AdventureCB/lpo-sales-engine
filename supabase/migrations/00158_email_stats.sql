-- Email marketing analytics: Klaviyo campaign + flow performance per calendar
-- month, pulled from the Reporting API (series reports, monthly interval) by a
-- nightly cron. Rates are recomputed from counts (opens ÷ delivered) so months
-- and groups aggregate correctly.
create table email_stats_monthly (
  month date not null,
  kind text not null check (kind in ('campaign', 'flow')),
  entity_id text not null,
  name text,
  status text,
  send_time timestamptz,            -- campaigns: when it went out
  recipients integer not null default 0,
  delivered integer not null default 0,
  opens_unique integer not null default 0,
  clicks_unique integer not null default 0,
  bounced integer not null default 0,
  unsubscribes integer not null default 0,
  spam_complaints integer not null default 0,
  conversions integer not null default 0,
  conversion_value_cents bigint not null default 0,
  synced_at timestamptz not null default now(),
  primary key (month, kind, entity_id)
);
alter table email_stats_monthly enable row level security;
create index idx_email_stats_month on email_stats_monthly (month);

select cron.schedule(
  'email-stats-nightly',
  '20 9 * * *',
  $$select net.http_get(url := 'https://lpo-sales-engine.vercel.app/api/cron/email-stats', headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')), timeout_milliseconds := 115000)$$
);
