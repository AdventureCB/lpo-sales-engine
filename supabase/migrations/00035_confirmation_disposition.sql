-- New disposition: confirmation call — separates post-deposit confirmation
-- work from sales connects in every downstream metric.
alter table call_events drop constraint call_events_disposition_check;
alter table call_events add constraint call_events_disposition_check
  check (disposition in ('connected', 'vm_dropped', 'bad_number', 'callback', 'confirmation'));
