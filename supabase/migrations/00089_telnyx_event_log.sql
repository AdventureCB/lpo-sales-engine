-- Raw Telnyx call-event log for debugging multi-leg flows (transfer/VM).
-- Low volume (call events only); prune periodically if it ever matters.
create table if not exists telnyx_event_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  event_type text,
  session_id text,
  leg_to text,
  leg_from text,
  client_state text,
  payload jsonb
);
create index if not exists idx_telnyx_event_log_at on telnyx_event_log (at desc);
alter table telnyx_event_log enable row level security;
