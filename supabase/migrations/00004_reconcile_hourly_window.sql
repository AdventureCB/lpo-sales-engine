-- The hourly sweep only needs a short window (Vercel's nightly cron does the
-- 48h deep pass); ?hours=6 keeps the per-participant call fetching well
-- inside Vercel's 60s function limit at high dial volume.

select cron.schedule(
  'reconcile-calls-hourly',
  '5 * * * *',
  $$
  select net.http_get(
    url := 'https://lpo-sales-engine.vercel.app/api/cron/reconcile-calls?hours=6',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 30000
  )
  $$
);
