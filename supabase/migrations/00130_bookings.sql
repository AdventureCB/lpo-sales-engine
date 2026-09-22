-- "Schedule with a Gravel Guide" (Kyle 9/22) — native replacement for Calendly.
-- Public booking pages: /book (round robin) and /book/<rep slug>. A booking
-- matches or creates the contact + deal, sets a ⭐ priority call activity for
-- the rep at the slot, and emails rep + customer from cainen@.
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references reps(id),
  via text not null check (via in ('direct', 'round_robin')),
  customer_name text not null,
  customer_email text,
  customer_phone text,
  customer_tz text,
  note text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'booked' check (status in ('booked', 'cancelled')),
  contact_id uuid,
  deal_id uuid,
  deal_created boolean not null default false,
  activity_id uuid,
  created_at timestamptz not null default now()
);
-- One booking per rep per slot, DB-enforced (two customers racing for the
-- same slot can't both win).
create unique index if not exists bookings_rep_slot_uniq on bookings (rep_id, start_at) where status = 'booked';
create index if not exists bookings_created_idx on bookings (created_at desc);
alter table bookings enable row level security;

alter table reps add column if not exists booking_slug text;
alter table reps add column if not exists booking_enabled boolean not null default false;
create unique index if not exists reps_booking_slug_uniq on reps (booking_slug) where booking_slug is not null;

-- Seed: active reps who carry a Telnyx line are the Gravel Guides; slug =
-- first name (lpo-sales-engine.vercel.app/book/jesse).
update reps
set booking_slug = lower(split_part(name, ' ', 1)), booking_enabled = true
where active = true and telnyx_number is not null and booking_slug is null
  and lower(split_part(name, ' ', 1)) not in ('cainen', 'kyle');

insert into deal_sources (name)
select 'Gravel Guide Call'
where not exists (select 1 from deal_sources where name = 'Gravel Guide Call');
