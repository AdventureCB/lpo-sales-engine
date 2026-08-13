-- Per-user notification dismissals. A notif_key is a stable id derived from
-- the source row (e.g. sms:<id>, intake:<eventId>, overdue:<activityId>), so
-- dismissing hides that specific item without touching the source.
create table if not exists notif_dismissals (
  user_email text not null,
  notif_key text not null,
  dismissed_at timestamptz not null default now(),
  primary key (user_email, notif_key)
);
alter table notif_dismissals enable row level security;
