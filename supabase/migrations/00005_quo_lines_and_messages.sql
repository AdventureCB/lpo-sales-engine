-- Reconciliation v2: pull ALL workspace lines (shared inboxes included) and
-- attribute calls/texts to the rep who handled them (call.userId), matching
-- how Quo analytics counts. Adds SMS tracking for the texts-sent metric.

create table quo_lines (
  phone_number_id text primary key,
  label text not null,
  phone_number text,
  active boolean not null default true
);

insert into quo_lines (phone_number_id, label, phone_number) values
  ('PN4tAddEF7', 'Parker',           '+15096616948'),
  ('PNQvoLc6PO', 'Jackson',          '+15093005629'),
  ('PN2nRozOQb', 'Customer Service', '+15093001277'),
  ('PNZuEepf4x', 'Primary',          '+15093508901'),
  ('PNvMf6Ib4K', 'Kecia',            '+15093005522');

create table message_events (
  id uuid primary key default gen_random_uuid(),
  quo_message_id text not null unique,   -- idempotent ingestion
  rep_id uuid references reps(id),       -- sender for outgoing; null inbound
  direction text check (direction in ('incoming', 'outgoing')),
  status text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_message_events_rep_day on message_events (rep_id, sent_at);

alter table quo_lines enable row level security;
alter table message_events enable row level security;
