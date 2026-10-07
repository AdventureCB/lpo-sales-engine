-- Distinct lookups for Meta attribution. Reading ad_campaign_daily /
-- ad_ad_daily through PostgREST hit the 1,000-row cap (a year of daily rows),
-- so current campaigns dropped out of the alias picker and ad→campaign maps
-- were truncated. Aggregate in SQL instead.

create or replace function facebook_campaigns()
returns table (campaign_id text, name text, last_day date)
language sql stable security definer set search_path = public as $$
  select distinct on (campaign_id) campaign_id, name, max(day) over (partition by campaign_id) as last_day
  from ad_campaign_daily
  where channel = 'facebook' and name is not null
  order by campaign_id, day desc;
$$;

create or replace function facebook_ad_campaigns(p_ad_ids text[] default null)
returns table (ad_id text, campaign_id text)
language sql stable security definer set search_path = public as $$
  select distinct on (ad_id) ad_id, campaign_id
  from ad_ad_daily
  where channel = 'facebook' and campaign_id is not null
    and (p_ad_ids is null or ad_id = any (p_ad_ids))
  order by ad_id, day desc;
$$;

-- Organic Meta traffic (page / bio links, Linktree) is not a paid click even
-- though Meta appends fbclid to it. Keep it out of the unresolved list.
create or replace function unresolved_meta_labels(p_days int default 90)
returns table (label text, content text, clicks bigint, visitors bigint, leads bigint, first_at timestamptz, last_at timestamptz)
language sql stable security definer set search_path = public as $$
  with t as (
    select lower(coalesce(campaign, '')) as label, coalesce(content, '') as content, visitor_id, at
    from web_touches
    where at >= now() - (p_days || ' days')::interval
      and (fbclid is not null or lower(source) in ('facebook','fb','meta','instagram','ig'))
      and (campaign is null or campaign !~ '^\d{5,}$')
      and not (
        lower(coalesce(medium, '')) in ('social','organic','bio','link_in_bio','referral')
        or lower(coalesce(source, '')) = 'linktree'
        or coalesce(content, '') ~* '(facebook_ua|link_in_bio)'
      )
  ),
  leads as (
    select t.label, t.content, count(distinct d.id) as leads
    from t
    join web_visitor_links l on l.visitor_id = t.visitor_id
    join crm_contacts c on c.emails @> jsonb_build_array(jsonb_build_object('value', l.email))
    join crm_deals d on d.contact_id = c.id and d.created_at >= t.at and d.created_at < t.at + interval '30 days'
    group by 1, 2
  )
  select t.label, t.content, count(*) as clicks, count(distinct t.visitor_id) as visitors,
         coalesce(max(leads.leads), 0) as leads, min(t.at), max(t.at)
  from t left join leads on leads.label = t.label and leads.content = t.content
  group by t.label, t.content
  order by clicks desc;
$$;
