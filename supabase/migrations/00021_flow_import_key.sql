-- Flow-feed imports (synced emails, deal change log) get one generic dedupe
-- key ("mail:<id>", "change:<id>") — separate id spaces from activities/notes.
alter table crm_activities add column pd_key text unique;
