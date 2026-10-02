-- Email tenure cohorts: how long each Klaviyo profile has been receiving
-- email. Synced from the Profiles API (subscriptions + created); tenure =
-- time since email-marketing consent (falls back to profile creation).
create table klaviyo_email_subs (
  profile_id text primary key,
  email text,
  created_at timestamptz,            -- Klaviyo profile created
  consent text,                      -- SUBSCRIBED | UNSUBSCRIBED | NEVER_SUBSCRIBED | null
  consent_at timestamptz,            -- email marketing consent timestamp
  suppressed boolean not null default false,
  last_event_at timestamptz,         -- Klaviyo last_event_date
  synced_at timestamptz not null default now()
);
alter table klaviyo_email_subs enable row level security;
create index idx_klaviyo_email_subs_email on klaviyo_email_subs (lower(email));
create index idx_klaviyo_email_subs_consent on klaviyo_email_subs (consent, consent_at);

create or replace function email_tenure_cohorts()
returns jsonb language sql stable security definer set search_path = public as $$
with subs as (
  select s.profile_id, lower(s.email) as email,
         coalesce(s.consent_at, s.created_at) as since
  from klaviyo_email_subs s
  where s.consent = 'SUBSCRIBED' and not s.suppressed and s.email is not null
),
engaged as (
  select distinct person_email as email
  from engagement_events
  where source = 'klaviyo' and type in ('email_open', 'email_click') and occurred_at >= now() - interval '90 days'
),
bucketed as (
  select case
           when since is null then 'unknown'
           when since > now() - interval '1 month' then '0'
           when since > now() - interval '3 months' then '1'
           when since > now() - interval '6 months' then '2'
           when since > now() - interval '12 months' then '3'
           when since > now() - interval '24 months' then '4'
           else '5' end as b,
         s.email,
         (e.email is not null) as eng
  from subs s left join engaged e on e.email = s.email
),
rows as (
  select b, count(*) as n, count(*) filter (where eng) as eng from bucketed group by b
)
select jsonb_build_object(
  'subscribed', (select count(*) from subs),
  'unsubscribed', (select count(*) from klaviyo_email_subs where consent = 'UNSUBSCRIBED'),
  'neverSubscribed', (select count(*) from klaviyo_email_subs where consent is null or consent = 'NEVER_SUBSCRIBED'),
  'suppressed', (select count(*) from klaviyo_email_subs where suppressed),
  'over6mo', (select count(*) from subs where since <= now() - interval '6 months'),
  'over12mo', (select count(*) from subs where since <= now() - interval '12 months'),
  'buckets', coalesce((select jsonb_agg(jsonb_build_object('key', b, 'count', n, 'engaged90', eng) order by b) from rows), '[]'::jsonb),
  'syncedAt', (select max(synced_at) from klaviyo_email_subs)
);
$$;

select cron.schedule(
  'klaviyo-email-subs-weekly',
  '35 9 * * 0',
  $$select net.http_get(url := 'https://lpo-sales-engine.vercel.app/api/cron/klaviyo-email-subs?reset=1', headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')), timeout_milliseconds := 115000)$$
);
-- Follow-up ticks finish the resumable scan through the week-day mornings.
select cron.schedule(
  'klaviyo-email-subs-continue',
  '*/15 10-11 * * 0',
  $$select net.http_get(url := 'https://lpo-sales-engine.vercel.app/api/cron/klaviyo-email-subs', headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')), timeout_milliseconds := 115000)$$
);
