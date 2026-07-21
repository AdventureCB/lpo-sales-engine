-- Vercel Hobby limits crons to daily, so high-frequency scheduling lives
-- here: pg_cron + pg_net call the Vercel endpoints on any cadence. The
-- Authorization bearer comes from Vault (secret name 'cron_secret', inserted
-- out-of-band — never committed). Vercel's own daily cron stays as fallback;
-- the endpoints are idempotent so overlap is harmless.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Hourly call reconciliation (webhooks are the live feed once configured;
-- this keeps the scoreboard fresh regardless).
select cron.schedule(
  'reconcile-calls-hourly',
  '5 * * * *',
  $$
  select net.http_get(
    url := 'https://lpo-sales-engine.vercel.app/api/cron/reconcile-calls',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 30000
  )
  $$
);
