-- Ad-attribution phase 2: Triple Whale ingest.
-- ad_spend: per-day per-channel spend from TW's summary API (TW aggregates
-- Meta/Google/etc; campaign-level spend isn't in TW's public API, so cost
-- math is channel-granularity — campaign ids still land per-order below).
create table if not exists ad_spend (
  day date not null,
  channel text not null,
  spend_cents integer not null,
  updated_at timestamptz not null default now(),
  primary key (day, channel)
);
alter table ad_spend enable row level security;

-- Per-order attribution journeys from TW's pixel (first/last click incl.
-- source + campaignId, journey summary). Joined to CRM via sales_orders
-- (shopify_order_id → customer_email → crm_contacts).
create table if not exists tw_order_attribution (
  shopify_order_id bigint primary key,
  order_name text,
  customer_shopify_id bigint,
  order_created_at timestamptz,
  total_price_cents integer,
  first_click jsonb,
  last_click jsonb,
  journey_events integer,
  journey_first_at timestamptz,
  journey_last_at timestamptz,
  attribution_raw jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists idx_twoa_customer on tw_order_attribution (customer_shopify_id);
alter table tw_order_attribution enable row level security;
