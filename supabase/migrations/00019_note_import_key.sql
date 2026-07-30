-- Pipedrive notes and activities have separate id spaces, so imported notes
-- need their own dedupe key alongside pipedrive_activity_id.
alter table crm_activities add column pipedrive_note_id bigint unique;
