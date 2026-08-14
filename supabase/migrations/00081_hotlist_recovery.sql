-- Hot-list deal recovery: create/reopen deals for contacts whose recent
-- marketing signals would qualify them for the hot list but who have no OPEN
-- deal. ~88% of engaged contacts have no open deal, so the hot list was blind
-- to them. This is a native intake engine ("Hot List Import") built on
-- processIntake — new deals land Cainen-owned (reprospect-pool ranked),
-- closed deals reopen to their previous owner for review.

-- Candidate contacts: recent signals meet the bar (buy-intent OR click OR ≥2
-- distinct signal types — deliberately NOT opens-only, which nearly everyone
-- does) AND no open deal exists for the email. Ordered buy-intent first.
create or replace function public.hotlist_recovery_candidates(
  p_window_start timestamptz,
  p_click_hours int,
  p_distinct_hours int,
  p_limit int default 25
) returns table (
  person_email text,
  buy_intent int,
  clicks int,
  distinct_types int,
  opens int,
  latest_at timestamptz,
  summary text
) language sql stable as $$
  with agg as (
    select
      lower(person_email) as email,
      count(*) filter (
        where type ~* '(checkout|builder_save|save.?build|cart|abandon|3d)'
          and occurred_at >= p_window_start
      )::int as buy_intent,
      count(*) filter (
        where type like '%click'
          and occurred_at >= now() - make_interval(hours => p_click_hours)
      )::int as clicks,
      count(distinct case
        when occurred_at >= now() - make_interval(hours => p_distinct_hours)
        then source || ':' || type end)::int as distinct_types,
      count(*) filter (
        where type like '%open' and occurred_at >= p_window_start
      )::int as opens,
      max(occurred_at) as latest_at
    from engagement_events
    where person_email is not null
      and occurred_at >= p_window_start
    group by lower(person_email)
  )
  select
    a.email, a.buy_intent, a.clicks, a.distinct_types, a.opens, a.latest_at,
    concat_ws(', ',
      case when a.buy_intent > 0 then a.buy_intent || ' buy-intent' end,
      case when a.clicks > 0 then a.clicks || ' click' || case when a.clicks > 1 then 's' else '' end end,
      case when a.distinct_types > 1 then a.distinct_types || ' signal types' end,
      case when a.opens > 0 then a.opens || ' opens' end
    ) as summary
  from agg a
  where (a.buy_intent > 0 or a.clicks > 0 or a.distinct_types >= 2)   -- the bar
    and a.email not like '%@lonepeakoverland.com'                     -- never staff
    and not exists (select 1 from app_users u where lower(u.email) = a.email)
    and not exists (
      select 1
      from crm_contacts c
      join crm_deals d on d.contact_id = c.id
      where d.status = 'open'
        and public.contact_email_set(c.emails) @> array[a.email]
    )
  order by a.buy_intent desc, a.latest_at desc
  limit p_limit
$$;

-- Allow the new adapter kind.
alter table intake_sources drop constraint if exists intake_sources_adapter_check;
alter table intake_sources add constraint intake_sources_adapter_check
  check (adapter = any (array[
    'shopify_abandoned_checkout','typeform','klaviyo_metric','klaviyo_list',
    'klaviyo_segment','webhook','hotlist_recovery'
  ]));

-- Seed the engine DISABLED — creating/reopening deals is consequential, so
-- Kyle flips it on in Settings after reviewing the preview. Config mirrors the
-- agreed behavior: native stage (Hot List Import has no Pipedrive id → pure
-- native writes), new deals → Cainen (reprospect pool), reopens → previous
-- owner, both land in the Hot List Import stage, owner notified.
insert into intake_sources (label, adapter, enabled, config)
select
  'Hot List Import',
  'hotlist_recovery',
  false,
  jsonb_build_object(
    'crm_stage_id', 'bdf4e751-c47c-45f0-b9dc-233a262c4ea7',
    'on_existing_open', 'skip',
    'on_existing_closed', 'reopen_assign',
    'reopen_keep_previous_owner', true,
    'reopen_to_default_stage', true,
    'notify_owner', true,
    'owner_pool', '[]'::jsonb,
    'fallback_owner_pipedrive_id', 24723797,
    'write_pipedrive', false,
    'source_name', 'Hot List Import',
    'title_template', 'Hot List Import - {name}',
    'recovery', jsonb_build_object('window_days', 7, 'click_hours', 72, 'distinct_hours', 72, 'per_sweep', 25)
  )
where not exists (select 1 from intake_sources where adapter = 'hotlist_recovery');
