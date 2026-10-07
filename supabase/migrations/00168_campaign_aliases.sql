-- Hand-typed utm_campaign labels ("mof", "retargeting") → real campaign ids.
-- Auto-resolution (ad id → campaign, unique campaign-name token match) covers
-- most; this table holds the admin's answers for the ambiguous rest, and is
-- applied to past and future clicks alike (lib/campaign-roas.ts).
create table if not exists campaign_aliases (
  channel text not null,
  label text not null,                  -- lower-cased utm_campaign as the click carried it
  campaign_id text not null,
  campaign_name text,
  created_by text,
  created_at timestamptz not null default now(),
  primary key (channel, label)
);
alter table campaign_aliases enable row level security;

-- Unresolved Meta clicks grouped by the labels they carry, with lead counts
-- (a lead = a deal created within 30 days after a click by a linked visitor).
create or replace function unresolved_meta_labels(p_days int default 90)
returns table (label text, content text, clicks bigint, visitors bigint, leads bigint, first_at timestamptz, last_at timestamptz)
language sql stable security definer set search_path = public as $$
  with t as (
    select lower(coalesce(campaign, '')) as label, coalesce(content, '') as content, visitor_id, at
    from web_touches
    where at >= now() - (p_days || ' days')::interval
      and (fbclid is not null or lower(source) in ('facebook','fb','meta','instagram','ig'))
      and (campaign is null or campaign !~ '^\d{5,}$')
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
