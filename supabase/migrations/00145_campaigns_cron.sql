-- Campaign engine tick every 15 minutes (auto-enroll → draft → send approved).
select cron.schedule(
  'campaigns-15min',
  '5,20,35,50 * * * *',
  $$select net.http_get(url := 'https://lpo-sales-engine.vercel.app/api/cron/campaigns', headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')), timeout_milliseconds := 115000)$$
);
