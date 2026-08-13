-- Media assets are real files (stored in the comm-media bucket) that attach
-- to emails, not URLs pasted into the body. comm_assets.url holds the storage
-- path for media; mime_type drives the attachment part.
insert into storage.buckets (id, name, public) values ('comm-media', 'comm-media', false)
  on conflict (id) do nothing;
alter table comm_assets add column if not exists mime_type text;
