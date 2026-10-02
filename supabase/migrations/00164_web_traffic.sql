-- Website traffic analytics (replaces the Triple Whale-based scorecard
-- feature). Source = Shopify's own sessions dataset (ShopifyQL), cached
-- locally: site totals per day, sessions per day × referrer, per day ×
-- device, and landing pages per WEEK (daily × page is too wide to cache).
create table web_traffic_daily (
  day date primary key,
  sessions integer not null default 0,
  visitors integer not null default 0,
  pageviews integer not null default 0,
  atc integer not null default 0,
  reached_checkout integer not null default 0,
  completed_checkout integer not null default 0,
  synced_at timestamptz not null default now()
);
create table web_traffic_sources (
  day date not null,
  source text not null default '',
  name text not null default '',
  sessions integer not null default 0,
  atc integer not null default 0,
  completed_checkout integer not null default 0,
  synced_at timestamptz not null default now(),
  primary key (day, source, name)
);
create table web_traffic_devices (
  day date not null,
  device text not null default '',
  sessions integer not null default 0,
  synced_at timestamptz not null default now(),
  primary key (day, device)
);
create table web_traffic_pages (
  week date not null,
  path text not null,
  sessions integer not null default 0,
  atc integer not null default 0,
  completed_checkout integer not null default 0,
  synced_at timestamptz not null default now(),
  primary key (week, path)
);
alter table web_traffic_daily enable row level security;
alter table web_traffic_sources enable row level security;
alter table web_traffic_devices enable row level security;
alter table web_traffic_pages enable row level security;
create index idx_web_traffic_pages_week on web_traffic_pages (week);

-- Nightly: refresh the trailing 14 days (Shopify revises recent days) and the
-- trailing 3 weeks of pages. Needs the Admin app's read_reports scope +
-- protected customer data (level 2) approval; until then the route reports
-- the error and the seeded history stands.
select cron.schedule(
  'web-traffic-nightly',
  '50 9 * * *',
  $$select net.http_get(url := 'https://lpo-sales-engine.vercel.app/api/cron/web-traffic', headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')), timeout_milliseconds := 115000)$$
);
