-- SMS consent per contact, with provenance (10DLC: prove when/where the
-- opt-in happened). 'opted_out' is reserved for real STOPs (Telnyx webhook,
-- later) and is never overwritten by a form answer.
alter table crm_contacts add column if not exists sms_consent text
  check (sms_consent in ('opted_in', 'declined', 'opted_out'));
alter table crm_contacts add column if not exists sms_consent_at timestamptz;
alter table crm_contacts add column if not exists sms_consent_source text;
