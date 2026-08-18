-- Per-user read state for text threads: the Texts-page dot should clear when
-- the thread is OPENED (Messenger semantics), not only when the rep replies.
-- Opening a conversation upserts read_at; the thread list marks unread when
-- the last inbound message is newer than the reader's read_at.
create table if not exists sms_thread_reads (
  user_email text not null,
  peer_phone text not null,
  read_at timestamptz not null default now(),
  primary key (user_email, peer_phone)
);

-- Standard posture: RLS on, no policies — anon sees nothing, service role only.
alter table sms_thread_reads enable row level security;
