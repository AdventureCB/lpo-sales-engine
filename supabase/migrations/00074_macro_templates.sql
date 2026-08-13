-- Macro library v2: shared TEMPLATES anyone can add, which each rep toggles
-- on to get a personal editable COPY. Templates stay untouched when a rep
-- edits their copy. Organized by channel (medium) then custom folder.
alter table comm_macros add column if not exists owner_email text;       -- null/template = shared; else the rep who owns this personal copy
alter table comm_macros add column if not exists is_template boolean not null default false;
alter table comm_macros add column if not exists template_id uuid references comm_macros (id) on delete set null;
alter table comm_macros add column if not exists folder text;            -- custom folder within a channel

-- Existing shared macros become org templates (the seed catalog).
update comm_macros set is_template = true where is_template = false and owner_email is null;

create index if not exists idx_comm_macros_owner on comm_macros (owner_email);
create index if not exists idx_comm_macros_template on comm_macros (template_id);
