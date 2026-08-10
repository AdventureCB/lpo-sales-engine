-- Typeform webhook receipts: hidden-field ad params per submission. Stored
-- raw and matched to a contact by email — immediately when possible, and
-- retried by cron for submissions that arrive before the Klaviyo->Pipedrive
-- pipeline creates the contact.
create table if not exists typeform_submissions (
  id uuid primary key default gen_random_uuid(),
  event_id text unique,
  form_id text,
  form_name text,
  email text,
  submitted_at timestamptz,
  hidden jsonb not null default '{}'::jsonb,
  matched_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_tf_unmatched on typeform_submissions (created_at) where matched_at is null;
alter table typeform_submissions enable row level security;
