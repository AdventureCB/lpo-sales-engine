-- Phase 1: per-rep Quo phone numbers for nightly call reconciliation,
-- plus a stable display order (Parker first, matching the approved UI).

alter table reps add column quo_phone_number_id text unique;
alter table reps add column quo_phone_number text;
alter table reps add column sort_order integer not null default 100;

update reps set quo_phone_number_id = 'PN4tAddEF7', quo_phone_number = '+15096616948', sort_order = 1
  where quo_user_id = 'USlRvDLVOp';  -- Parker
update reps set quo_phone_number_id = 'PNQvoLc6PO', quo_phone_number = '+15093005629', sort_order = 2
  where quo_user_id = 'USSvY8hkeK';  -- Jackson
