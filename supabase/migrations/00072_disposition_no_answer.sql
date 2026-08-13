-- Add "no_answer" disposition — a call that rang out where leaving a
-- voicemail wasn't an option (distinct from vm_dropped and bad_number).
alter table call_events drop constraint if exists call_events_disposition_check;
alter table call_events add constraint call_events_disposition_check
  check (disposition in ('connected', 'vm_dropped', 'no_answer', 'bad_number', 'callback', 'confirmation'));
