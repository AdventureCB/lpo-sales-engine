-- Texts page "done" checkbox (reps 10/16): per user per counterparty. A thread
-- is done while its last message is no newer than done_through_at — a fresh
-- inbound after that automatically puts it back in "to do".
create table if not exists sms_thread_done (
  user_email text not null,
  peer_phone text not null,
  done_at timestamptz not null default now(),
  done_through_at timestamptz not null,
  primary key (user_email, peer_phone)
);
alter table sms_thread_done enable row level security;
