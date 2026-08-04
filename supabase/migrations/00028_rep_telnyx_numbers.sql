-- Per-rep Telnyx numbers, assigned in the admin Settings tab. Browser calls
-- use the rep's own number as caller ID (falls back to the account default).
alter table reps add column telnyx_number text;
