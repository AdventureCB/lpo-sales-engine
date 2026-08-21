-- Engine-owned buy signals (builder saves, carts, checkouts) no longer
-- qualify a contact for Hot List Import BY THEMSELVES — the dedicated
-- engines (Saved Build, Abandoned Cart) own those and create correctly
-- titled/sourced deals when their event arrives. Recovery still counts
-- buy_intent for ranking/summary, and still catches these contacts when
-- they ALSO show clicks or multiple signal types (the claim logic in
-- processIntake repairs any residual race).
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
  -- Everyone who has ever bought: real Shopify orders (authoritative) OR a
  -- Klaviyo purchase signal.
  customers as (
    select distinct lower(customer_email) as email
    from sales_orders where customer_email is not null
    union
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
  where (a.clicks > 0 or a.distinct_types >= 2)                       -- the bar (buy-intent alone = engine territory)
    and a.email not like '%@lonepeakoverland.com'                     -- never staff
    and not exists (select 1 from app_users u where lower(u.email) = a.email)
    and not exists (select 1 from customers cu where cu.email = a.email)  -- already bought
    and not exists (
      select 1
      from crm_contacts c
      join crm_deals d on d.contact_id = c.id
      where d.status in ('open', 'won')
        and public.contact_email_set(c.emails) @> array[a.email]
    )
  order by a.buy_intent desc, a.latest_at desc
  limit p_limit
$$;
