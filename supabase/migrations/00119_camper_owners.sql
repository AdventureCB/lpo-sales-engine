-- Camper-owner directory for the Demo Finder (Kyle 9/15). Synced from Shopify
-- orders that contain a camper unit; geocoded by shipping zip for proximity
-- search. Reps find owners near a prospect and ask if they'll host/show a demo;
-- a "yes" flips willing_to_demo (warm).

create table camper_owners (
  id uuid primary key default gen_random_uuid(),
  owner_key text not null unique,              -- shopify customer id, else lower(email)
  shopify_customer_id text,
  name text,
  email text,
  phone text,
  city text,
  state text,
  zip text,
  lat double precision,
  lng double precision,
  version text not null,                        -- 'v1' | 'v2' | 'both'
  camper_order_name text,                       -- e.g. "#1418" (most recent camper order)
  camper_order_at timestamptz,
  order_line_items jsonb,                        -- that order's items (at-a-glance accessories)
  contact_id uuid references crm_contacts(id) on delete set null,
  willing_to_demo boolean not null default false,
  willing_at timestamptz,
  willing_by text,
  notes text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index idx_camper_owners_state on camper_owners (state);
create index idx_camper_owners_geo on camper_owners (lat, lng);
create index idx_camper_owners_willing on camper_owners (willing_to_demo) where willing_to_demo;

alter table camper_owners enable row level security;
