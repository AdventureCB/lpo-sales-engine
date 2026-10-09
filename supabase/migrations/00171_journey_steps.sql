-- Journey analytics: every recorded step (ad/email touch, or a site session
-- start) for deals created in a window, joined through the contact's emails →
-- linked visitors. Steps up to 30 days after creation (or the win) are
-- included so post-lead retargeting shows in the path. Folded in TS.
create or replace function journey_steps(p_start timestamptz, p_end timestamptz)
returns table (
  deal_id uuid, deal_created timestamptz, won_at timestamptz, status text, value_cents bigint, source_name text,
  step_at timestamptz, kind text, source text, medium text, campaign text, content text,
  has_gclid boolean, has_fbclid boolean, landing text, referrer text
)
language sql stable security definer set search_path = public as $$
  with deals as (
    select d.id, d.created_at, d.won_at, d.status, d.value_cents, ds.name as source_name, d.contact_id
    from crm_deals d left join deal_sources ds on ds.id = d.source_id
    where d.created_at >= p_start and d.created_at <= p_end
  ),
  vis as (
    select distinct dl.id as deal_id, l.visitor_id
    from deals dl
    join crm_contacts c on c.id = dl.contact_id
    cross join lateral jsonb_array_elements(coalesce(c.emails, '[]'::jsonb)) e
    join web_visitor_links l on lower(l.email) = lower(e->>'value')
  ),
  touches as (
    select v.deal_id, t.at as step_at, 'touch'::text as kind, t.source, t.medium, t.campaign, t.content,
           t.gclid is not null or t.gbraid is not null or t.wbraid is not null as has_gclid,
           t.fbclid is not null as has_fbclid,
           regexp_replace(coalesce(t.landing, ''), '^https?://[^/]+', '') as landing, t.referrer
    from vis v join web_touches t on t.visitor_id = v.visitor_id
  ),
  sessions as (
    select v.deal_id, min(e.at) as step_at, 'visit'::text as kind, null::text as source, null::text as medium, null::text as campaign, null::text as content,
           false as has_gclid, false as has_fbclid,
           (array_agg(e.path order by e.at))[1] as landing, (array_agg(e.referrer order by e.at))[1] as referrer
    from vis v join web_events e on e.visitor_id = v.visitor_id and e.type = 'pageview'
    group by v.deal_id, e.session_id
  ),
  steps as (select * from touches union all select * from sessions)
  select d.id, d.created_at, d.won_at, d.status, d.value_cents, d.source_name,
         s.step_at, s.kind, s.source, s.medium, s.campaign, s.content, s.has_gclid, s.has_fbclid, s.landing, s.referrer
  from deals d join steps s on s.deal_id = d.id
  where s.step_at <= greatest(d.created_at, coalesce(d.won_at, d.created_at)) + interval '30 days'
  order by d.id, s.step_at;
$$;
