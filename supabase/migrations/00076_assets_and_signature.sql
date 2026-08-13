-- Reps can add assets too (owner_email attributes who added it; delete is
-- owner-or-admin). And each rep gets an email signature appended to every
-- email they send.
alter table comm_assets add column if not exists owner_email text;
alter table app_users add column if not exists email_signature text;
