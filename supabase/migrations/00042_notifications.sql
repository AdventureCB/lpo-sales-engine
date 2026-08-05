-- Per-user notification read-state: the bell badge counts events newer
-- than seen_at (overdue activities always count until handled).
create table user_notif_state (
  user_email text primary key,
  seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table user_notif_state enable row level security;
