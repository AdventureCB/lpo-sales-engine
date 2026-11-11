-- Build Survey funnel analytics (Kyle 11/11; brief: build-survey-analytics-crm.md
-- from the website session). The survey on /pages/build-your-camper hands
-- structured events ({t:"sv", n, run, step, i, ms, a, …}) to attr.js, which
-- beacons them to /api/attr/events with the visitor id. Stored as rows
-- (every metric groups by step) plus a per-run rollup refreshed on ingest.

create table if not exists survey_events (
  id          bigserial primary key,
  received_at timestamptz not null default now(),
  at          timestamptz not null,
  vid         text,
  sid         text,
  run_id      text not null,
  form        text not null default 'build-survey',
  version     text,
  name        text not null,
  step        text,
  step_index  int,
  ms          int,
  answer      text,
  data        jsonb,
  test        boolean not null default false,
  ua          text
);
create index if not exists idx_survey_events_form_at on survey_events (form, at);
create index if not exists idx_survey_events_run on survey_events (run_id);
create index if not exists idx_survey_events_vid on survey_events (vid);
alter table survey_events enable row level security;

create table if not exists survey_runs (
  run_id          text primary key,
  vid             text,
  form            text,
  version         text,
  test            boolean not null default false,
  started_at      timestamptz,
  last_event_at   timestamptz,
  device          text,
  furthest_index  int,
  furthest_step   text,
  submitted       boolean not null default false,
  submission_id   text,
  quote_opened    boolean,
  has_truck       boolean,
  active_ms_total bigint,
  source          text,      -- visitor's last attribution touch at/before the run (web_touches)
  campaign        text,
  updated_at      timestamptz not null default now()
);
create index if not exists idx_survey_runs_started on survey_runs (form, started_at);
create index if not exists idx_survey_runs_vid on survey_runs (vid);
create index if not exists idx_survey_runs_submission on survey_runs (submission_id);
alter table survey_runs enable row level security;

create or replace function refresh_survey_runs(p_runs text[])
returns void language sql security definer set search_path = public as $$
  insert into survey_runs as r (run_id, vid, form, version, test, started_at, last_event_at, device, furthest_index, furthest_step,
                                submitted, submission_id, quote_opened, has_truck, active_ms_total, source, campaign, updated_at)
  select e.run_id,
         max(e.vid),
         max(e.form),
         max(e.version),
         bool_or(e.test),
         min(e.at),
         max(e.at),
         max(e.data->>'device') filter (where e.name = 'start'),
         max(e.step_index) filter (where e.name in ('view','done','back','submit')),
         (array_agg(e.step order by e.step_index desc nulls last, e.at desc) filter (where e.name in ('view','done','back','submit') and e.step_index is not null))[1],
         bool_or(e.name = 'submit'),
         max(e.data->>'sid') filter (where e.name = 'submit'),
         bool_or((e.data->>'quote')::boolean) filter (where e.name = 'submit'),
         coalesce(
           bool_or((e.data->>'has_truck')::boolean) filter (where e.name = 'submit'),
           bool_or(e.answer is distinct from 'No truck yet') filter (where e.name = 'done' and e.step = 'make')
         ),
         sum(e.ms) filter (where e.name in ('done','back','submit')),
         (select t.source from web_touches t where t.visitor_id = max(e.vid) and t.at <= min(e.at) + interval '5 minutes' order by t.at desc limit 1),
         (select t.campaign from web_touches t where t.visitor_id = max(e.vid) and t.at <= min(e.at) + interval '5 minutes' order by t.at desc limit 1),
         now()
  from survey_events e
  where e.run_id = any (p_runs)
  group by e.run_id
  on conflict (run_id) do update set
    vid = excluded.vid, form = excluded.form, version = excluded.version, test = excluded.test,
    started_at = excluded.started_at, last_event_at = excluded.last_event_at, device = coalesce(excluded.device, r.device),
    furthest_index = excluded.furthest_index, furthest_step = excluded.furthest_step, submitted = excluded.submitted,
    submission_id = excluded.submission_id, quote_opened = excluded.quote_opened, has_truck = excluded.has_truck,
    active_ms_total = excluded.active_ms_total, source = coalesce(excluded.source, r.source), campaign = coalesce(excluded.campaign, r.campaign),
    updated_at = now();
$$;

-- Everything the page shows, in one call. Step order is fixed (brief §"What
-- the survey is"); a survey version change bumps `v` — filter by version.
create or replace function survey_funnel(
  p_from timestamptz, p_to timestamptz,
  p_form text default 'build-survey', p_device text default null, p_version text default null,
  p_truck text default null, p_source text default null, p_test boolean default false
) returns jsonb language sql stable security definer set search_path = public as $$
with steps(i, step, label) as (values
  (1,'make','Truck make'),(2,'model','Model + years'),(3,'bed','Bed length'),(4,'color','Paint'),
  (5,'arrive','Arriving (3D build appears)'),(6,'weekday','Truck as a truck'),(7,'never','Sleeping'),(8,'windows','Windows'),
  (9,'climate','Climate'),(10,'power','Power'),(11,'lighting','Lighting'),(12,'water','Water'),(13,'gear','Gear'),(14,'gate','Contact form')
),
runs as (
  select * from survey_runs r
  where r.form = p_form and r.started_at >= p_from and r.started_at < p_to
    and (p_test or not r.test)
    and (p_device is null or r.device = p_device)
    and (p_version is null or r.version = p_version)
    and (p_truck is null or (p_truck = 'truck' and r.has_truck is not false) or (p_truck = 'no_truck' and r.has_truck = false))
    and (p_source is null or coalesce(r.source, '(direct)') = p_source)
    and exists (select 1 from survey_events s where s.run_id = r.run_id and s.name = 'start')
),
ev as (select e.* from survey_events e join runs r on r.run_id = e.run_id),
-- Per-run time on a step = sum of ms over that run's done + back for the step,
-- only for runs that completed it; the gate uses submit.ms. Capped at 10 min.
run_step_time as (
  select run_id, step, least(sum(ms), 600000) as ms
  from ev where name in ('done','back') and step is not null and ms is not null
  group by run_id, step
  having bool_or(name = 'done')
  union all
  select run_id, 'gate', least(max(ms), 600000) from ev where name = 'submit' and ms is not null group by run_id
),
funnel as (
  select s.i, s.step, s.label,
    (select count(*) from runs r where coalesce(r.furthest_index, 0) >= s.i) as reached,
    (select count(*) from runs r where coalesce(r.furthest_index, 0) = s.i and not r.submitted and r.last_event_at < now() - interval '30 minutes') as dropped,
    (select count(distinct run_id) from ev where name = 'back' and step = s.step) as backs,
    (select count(distinct run_id) from ev where name = 'change' and step = s.step) as changes,
    (select round(avg(ms)) from run_step_time t where t.step = s.step) as avg_ms,
    (select percentile_cont(0.5) within group (order by ms) from run_step_time t where t.step = s.step) as median_ms,
    (select percentile_cont(0.75) within group (order by ms) from run_step_time t where t.step = s.step) as p75_ms,
    (select count(*) from run_step_time t where t.step = s.step) as timed
  from steps s
),
last_answer as (
  select distinct on (run_id, step) run_id, step, answer
  from ev where name = 'done' and answer is not null
  order by run_id, step, at desc
),
answers as (
  select a.step, a.answer, count(*) n,
         row_number() over (partition by a.step order by count(*) desc) rk,
         sum(count(*)) over (partition by a.step) total
  from last_answer a group by a.step, a.answer
),
more as (select data->>'product' product, count(distinct run_id) runs from ev where name = 'more' group by 1),
reveals as (select (data->>'wait_ms')::numeric wait_ms, (data->>'top_closed')::boolean top_closed from ev where name = 'reveal'),
invalid_fields as (
  select trim(f) field, count(*) n from ev, regexp_split_to_table(coalesce(data->>'fields', ''), ',') f
  where name = 'invalid' and trim(f) <> '' group by 1
),
fails as (select coalesce(data->>'err', '(unknown)') err, count(*) n from ev where name = 'submit_fail' group by 1)
select jsonb_build_object(
  'headline', (select jsonb_build_object(
      'started', count(*),
      'saw3d', count(*) filter (where coalesce(furthest_index,0) >= 5),
      'reachedForm', count(*) filter (where coalesce(furthest_index,0) >= 14),
      'submitted', count(*) filter (where submitted),
      'quotes', count(*) filter (where submitted and quote_opened),
      'medianCompleteMs', percentile_cont(0.5) within group (order by active_ms_total) filter (where submitted),
      'active', count(*) filter (where not submitted and last_event_at >= now() - interval '30 minutes')
    ) from runs),
  'funnel', (select jsonb_agg(jsonb_build_object('i', i, 'step', step, 'label', label, 'reached', reached, 'dropped', dropped,
      'backs', backs, 'changes', changes, 'avgMs', avg_ms, 'medianMs', median_ms, 'p75Ms', p75_ms, 'timed', timed) order by i) from funnel),
  'answers', (select coalesce(jsonb_object_agg(step, items), '{}'::jsonb) from (
      select step, jsonb_agg(jsonb_build_object('answer', answer, 'n', n, 'total', total) order by n desc) items
      from answers where rk <= 10 group by step) x),
  'engagement', jsonb_build_object(
      'more', (select coalesce(jsonb_agg(jsonb_build_object('product', product, 'runs', runs) order by runs desc), '[]'::jsonb) from more),
      'runsWithMore', (select count(distinct run_id) from ev where name = 'more'),
      'runsWithSound', (select count(distinct run_id) from ev where name = 'sound' and (data->>'on')::boolean)),
  'viewer', jsonb_build_object(
      'reveals', (select count(*) from reveals),
      'medianWaitMs', (select percentile_cont(0.5) within group (order by wait_ms) from reveals),
      'p90WaitMs', (select percentile_cont(0.9) within group (order by wait_ms) from reveals),
      'topOpen', (select count(*) from reveals where top_closed = false),
      'blocked', (select count(distinct run_id) from ev where name = 'canvas_blocked'),
      'reached4', (select count(*) from runs where coalesce(furthest_index,0) >= 4)),
  'gate', jsonb_build_object(
      'invalid', (select count(*) from ev where name = 'invalid'),
      'invalidRuns', (select count(distinct run_id) from ev where name = 'invalid'),
      'fields', (select coalesce(jsonb_agg(jsonb_build_object('field', field, 'n', n) order by n desc), '[]'::jsonb) from invalid_fields),
      'fails', (select coalesce(jsonb_agg(jsonb_build_object('err', err, 'n', n) order by n desc), '[]'::jsonb) from fails)),
  'versions', (select coalesce(jsonb_agg(distinct version), '[]'::jsonb) from survey_runs where form = p_form and version is not null),
  'sources', (select coalesce(jsonb_agg(distinct coalesce(source, '(direct)')), '[]'::jsonb) from survey_runs where form = p_form and started_at >= p_from and started_at < p_to),
  'abandonedKnown', (select coalesce(jsonb_agg(x order by x->>'lastAt' desc), '[]'::jsonb) from (
      select jsonb_build_object('runId', r.run_id, 'lastAt', r.last_event_at, 'furthestStep', r.furthest_step, 'furthestIndex', r.furthest_index,
               'contactId', c.id, 'name', c.name, 'email', l.email, 'dnc', c.dnc,
               'dealId', (select d.id from crm_deals d where d.contact_id = c.id order by (d.status = 'open') desc, d.updated_at desc limit 1)) x
      from runs r
      join lateral (select * from web_visitor_links l where l.visitor_id = r.vid order by l.linked_at desc limit 1) l on true
      left join crm_contacts c on c.id = l.contact_id
      where not r.submitted and r.last_event_at < now() - interval '30 minutes' and coalesce(c.dnc, false) = false
      limit 100) y),
  'recent', (select coalesce(jsonb_agg(x order by x->>'startedAt' desc), '[]'::jsonb) from (
      select jsonb_build_object('runId', run_id, 'startedAt', started_at, 'device', device, 'furthestStep', furthest_step, 'furthestIndex', furthest_index,
               'submitted', submitted, 'activeMs', active_ms_total, 'source', source, 'test', test) x
      from runs order by started_at desc limit 60) y)
);
$$;
