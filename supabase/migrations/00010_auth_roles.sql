-- Phase 3: roles. app_users maps Supabase Auth users to a role and (for
-- sales) their rep row. Hot flags remember the deal owner's Pipedrive user
-- id so role filtering never needs a live Pipedrive call.

create table app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  role text not null check (role in ('admin', 'sales')),
  rep_id uuid references reps (id),
  created_at timestamptz not null default now()
);

alter table app_users enable row level security;

alter table hot_flags add column owner_pipedrive_id bigint;

update reps set pipedrive_user_id = 24081760 where quo_user_id = 'USlRvDLVOp';  -- Parker
update reps set pipedrive_user_id = 24391245 where quo_user_id = 'USSvY8hkeK';  -- Jackson
