-- Per-rep Telnyx identity: own credential connection + credential, so
-- inbound calls to a rep's number ring that rep's browser (and only theirs).
alter table reps add column telnyx_connection_id text;
alter table reps add column telnyx_credential_id text;
