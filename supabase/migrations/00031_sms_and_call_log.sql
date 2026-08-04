-- Text conversation store (message BODIES — message_events is metrics-only)
-- plus set-based phone→contact resolution for the call log and thread list.
-- Provider-agnostic: Quo rows now, Telnyx rows after migration.

create table sms_messages (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'quo' check (provider in ('quo', 'telnyx')),
  provider_message_id text not null,
  rep_id uuid references reps(id),
  direction text check (direction in ('incoming', 'outgoing')),
  status text,
  phone_number_id text,          -- provider line id (Quo PN…)
  our_number text,               -- our line E164 when known
  peer_phone text not null,      -- the customer side, E164
  body text,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (provider, provider_message_id)
);

create index idx_sms_messages_peer on sms_messages (peer_phone, sent_at desc);
create index idx_sms_messages_sent on sms_messages (sent_at desc);

alter table sms_messages enable row level security;

-- Resolve many phones to CRM contacts + best deal in one round trip
-- (uses the GIN index on crm_contacts.phones from 00022).
create or replace function contacts_by_phones(p_phones text[])
returns table(phone text, contact_id uuid, contact_name text, crm_deal_id uuid, deal_title text)
language sql stable as $$
  select p.phone, c.id, c.name, d.id, d.title
  from unnest(p_phones) as p(phone)
  join crm_contacts c
    on c.phones @> jsonb_build_array(jsonb_build_object('e164', p.phone))
  left join lateral (
    select id, title from crm_deals
    where contact_id = c.id
    order by (status = 'open') desc, updated_at desc
    limit 1
  ) d on true
$$;

-- Latest message per counterparty — thread list without the 1000-row cap.
create or replace function sms_threads(p_limit int default 200)
returns table(peer_phone text, last_at timestamptz, last_body text,
              last_direction text, awaiting_reply boolean, msg_count bigint)
language sql stable as $$
  select t.peer_phone, t.sent_at, t.body, t.direction,
         (t.direction = 'incoming'), n.cnt
  from (
    select distinct on (peer_phone) peer_phone, sent_at, body, direction
    from sms_messages
    order by peer_phone, sent_at desc
  ) t
  join lateral (
    select count(*) cnt from sms_messages m where m.peer_phone = t.peer_phone
  ) n on true
  order by t.sent_at desc
  limit p_limit
$$;
