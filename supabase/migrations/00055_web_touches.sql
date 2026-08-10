-- Direct first-party touch store (replaces porting touch history through
-- Klaviyo/cart attributes). attr.js beacons every ad touch here keyed by a
-- persistent visitor id; identity events (order, Klaviyo profile, Typeform)
-- carry only the tiny attr_vid pointer, which links visitor -> contact.
create table if not exists web_touches (
  id uuid primary key default gen_random_uuid(),
  visitor_id text not null,
  at timestamptz not null,
  source text, medium text, campaign text, content text, term text,
  gclid text, gbraid text, wbraid text, fbclid text, msclkid text, ttclid text,
  landing text, referrer text,
  created_at timestamptz not null default now()
);
create index if not exists idx_web_touches_visitor on web_touches (visitor_id, at);
alter table web_touches enable row level security;

create table if not exists web_visitor_links (
  visitor_id text primary key,
  email text not null,
  contact_id uuid,
  linked_at timestamptz not null default now()
);
create index if not exists idx_web_visitor_links_email on web_visitor_links (email);
alter table web_visitor_links enable row level security;
