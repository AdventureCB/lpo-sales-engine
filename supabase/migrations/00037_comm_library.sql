-- Outreach library: message macros + shared URL/media assets, used by the
-- deal-page comm bar (Text / WhatsApp / Email composers).
create table comm_macros (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('sms', 'whatsapp', 'email', 'any')),
  name text not null,
  subject text,                 -- email macros only
  body text not null,           -- {{name}} {{first_name}} placeholders supported
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table comm_assets (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('url', 'media')),
  name text not null,
  url text not null,
  created_at timestamptz not null default now()
);

alter table comm_macros enable row level security;
alter table comm_assets enable row level security;
