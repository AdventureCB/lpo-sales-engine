-- Hot List Import must not recover people who already bought. Exclude any
-- candidate whose signals include an order event (Placed Order / Ordered
-- Product / Fulfilled Order) and any contact with an open OR won (confirmed)
-- deal — we still recover LOST deals, never confirmed ones.
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
  ),
  -- Anyone who has ever ordered — excluded regardless of engagement.
  ordered as (
    select distinct lower(person_email) as email
    from engagement_events
    where person_email is not null
      and type in ('placed_order', 'ordered_product', 'fulfilled_order')
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
    and not exists (select 1 from ordered o where o.email = a.email)   -- already bought
    and not exists (
      select 1
      from crm_contacts c
      join crm_deals d on d.contact_id = c.id
      where d.status in ('open', 'won')                               -- open or confirmed customer
        and public.contact_email_set(c.emails) @> array[a.email]
    )
  order by a.buy_intent desc, a.latest_at desc
  limit p_limit
$$;
