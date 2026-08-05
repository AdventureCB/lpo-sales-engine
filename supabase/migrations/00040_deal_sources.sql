-- Managed deal sources. Pipedrive's native "channel" enum maps directly
-- (pipedrive_channel_id); rows without a channel id are native sources for
-- the post-Pipedrive era. Addable/editable client-side.
create table deal_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  pipedrive_channel_id int unique,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table crm_deals add column source_id uuid references deal_sources(id);
create index idx_crm_deals_source on crm_deals (source_id);

alter table deal_sources enable row level security;
