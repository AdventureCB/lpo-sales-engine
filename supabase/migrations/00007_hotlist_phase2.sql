-- Phase 2: hot-list flag metadata for the dashboard, plus the true 15-minute
-- sweep via pg_cron (Vercel Hobby can't cron faster than daily).

alter table hot_flags add column signals jsonb;
alter table hot_flags add column deal_title text;
alter table hot_flags add column owner_name text;
alter table hot_flags add column dismissed_by text;

select cron.schedule(
  'hot-list-15min',
  '*/15 * * * *',
  $$
  select net.http_get(
    url := 'https://lpo-sales-engine.vercel.app/api/cron/hot-list',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 55000
  )
  $$
);

-- The daily Vercel cron for /api/cron/hot-list stays as a no-op fallback.
