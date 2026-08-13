-- A macro can carry pre-assigned assets (URL links + media attachments).
-- Applying the macro pulls them in by default; the rep can still swap in
-- their own. Copied onto the personal macro when a template is toggled on.
alter table comm_macros add column if not exists asset_ids uuid[] not null default '{}';
