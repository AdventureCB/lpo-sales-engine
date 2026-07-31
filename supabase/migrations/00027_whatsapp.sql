-- Klaviyo Conversations (WhatsApp) integration: account-level OAuth tokens
-- + a local mirror of conversation messages so the inbox reads instantly
-- from our own DB. Service-role only.
create table klaviyo_oauth (
  id integer primary key default 1 check (id = 1),
  access_token text,
  refresh_token text not null,
  token_expires_at timestamptz,
  scopes text,
  connected_by text,
  status text not null default 'active' check (status in ('active', 'error', 'disconnected')),
  last_error text,
  connected_at timestamptz not null default now()
);
alter table klaviyo_oauth enable row level security;

create table whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  klaviyo_message_id text unique,
  profile_id text not null,
  contact_id uuid references crm_contacts (id),
  direction text check (direction in ('inbound', 'outbound')),
  body text,
  sent_at timestamptz,
  raw jsonb,
  created_at timestamptz not null default now()
);
create index idx_wa_profile on whatsapp_messages (profile_id, sent_at desc);
create index idx_wa_recent on whatsapp_messages (sent_at desc);
alter table whatsapp_messages enable row level security;
