-- Per-rep Gmail OAuth: refresh tokens + sync cursor. Service-role access
-- only (RLS enabled, no policies) — tokens never reach the client.
create table gmail_accounts (
  user_email text primary key,               -- app_users.email
  google_email text not null,
  refresh_token text not null,
  access_token text,
  token_expires_at timestamptz,
  last_synced_at timestamptz,
  status text not null default 'active' check (status in ('active', 'error', 'disconnected')),
  last_error text,
  connected_at timestamptz not null default now()
);
alter table gmail_accounts enable row level security;
