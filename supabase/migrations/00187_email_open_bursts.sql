-- Open tracking: ignore bulk pixel fetches (Kyle 11/11 — Jackson's campaign
-- showed 100% opens; 260 of 405 "first opens" landed in same-second bursts of
-- up to 48 recipients, i.e. ONE client loading the images of his Sent folder,
-- not 48 buyers). Jesse / Colton sit at 66% with zero bursts.
--
-- 1) Every pixel hit is logged with ip + user agent.
-- 2) A hit is BULK when, in the last 10 seconds, hits from the same IP already
--    landed on 4+ OTHER tokens of the same rep. Bulk hits count in
--    bulk_opens, not opens; when a burst trips, the hits that opened it are
--    demoted too.
-- 3) Historical repair: tokens whose first/last open sit in a 5+ same-second
--    burst for that rep are reclassified (opens → bulk_opens).

create table if not exists email_track_hits (
  id bigserial primary key,
  token uuid not null,
  at timestamptz not null default now(),
  ip text,
  ua text,
  bulk boolean not null default false
);
create index if not exists idx_email_track_hits_token on email_track_hits (token, at);
create index if not exists idx_email_track_hits_at on email_track_hits (at);
alter table email_track_hits enable row level security;

alter table email_tracking add column if not exists bulk_opens int not null default 0;

drop function if exists public.email_track_open(uuid);

create or replace function public.email_track_open(p_token uuid, p_ip text default null, p_ua text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_rep text;
  v_others int;
  v_bulk boolean := false;
begin
  select rep_email into v_rep from email_tracking where token = p_token;
  if v_rep is null then return; end if;

  select count(distinct h.token) into v_others
  from email_track_hits h join email_tracking t on t.token = h.token
  where t.rep_email = v_rep and h.token <> p_token
    and h.at > now() - interval '10 seconds'
    and (p_ip is null or h.ip is null or h.ip = p_ip);
  v_bulk := v_others >= 4;

  insert into email_track_hits (token, ip, ua, bulk) values (p_token, p_ip, left(p_ua, 300), v_bulk);

  if v_bulk then
    update email_tracking set bulk_opens = bulk_opens + 1 where token = p_token;
    -- The hits that opened this burst were counted as real — take them back.
    with demoted as (
      update email_track_hits h set bulk = true
      from email_tracking t
      where t.token = h.token and t.rep_email = v_rep and h.bulk = false and h.token <> p_token
        and h.at > now() - interval '10 seconds'
        and (p_ip is null or h.ip is null or h.ip = p_ip)
      returning h.token
    ),
    n as (select token, count(*) as c from demoted group by token)
    update email_tracking t
    set opens = greatest(0, t.opens - n.c),
        bulk_opens = t.bulk_opens + n.c,
        first_open_at = case when greatest(0, t.opens - n.c) = 0 then null
                             else coalesce((select min(x.at) from email_track_hits x where x.token = t.token and not x.bulk), t.first_open_at) end,
        last_open_at  = case when greatest(0, t.opens - n.c) = 0 then null
                             else coalesce((select max(x.at) from email_track_hits x where x.token = t.token and not x.bulk), t.last_open_at) end
    from n where n.token = t.token;
  else
    update email_tracking
    set opens = opens + 1, first_open_at = coalesce(first_open_at, now()), last_open_at = now()
    where token = p_token;
  end if;
end;
$$;

-- Historical repair.
with fb as (
  select rep_email, date_trunc('second', first_open_at) as sec from email_tracking
  where first_open_at is not null group by 1, 2 having count(*) >= 5
),
lb as (
  select rep_email, date_trunc('second', last_open_at) as sec from email_tracking
  where last_open_at is not null group by 1, 2 having count(*) >= 5
),
c as (
  select t.token, t.opens, t.first_open_at, t.last_open_at,
         exists (select 1 from fb where fb.rep_email = t.rep_email and fb.sec = date_trunc('second', t.first_open_at)) as first_bulk,
         exists (select 1 from lb where lb.rep_email = t.rep_email and lb.sec = date_trunc('second', t.last_open_at)) as last_bulk
  from email_tracking t where t.opens > 0
),
cls as (
  select token, opens, first_open_at, last_open_at, first_bulk, last_bulk,
         -- all-bulk: the only timestamps we have are burst timestamps
         (first_bulk and (last_bulk or last_open_at = first_open_at or opens = 1)) as all_bulk
  from c where first_bulk or last_bulk
)
update email_tracking t
set bulk_opens = t.bulk_opens + case when cls.all_bulk then cls.opens else 1 end,
    opens      = case when cls.all_bulk then 0 else greatest(1, cls.opens - 1) end,
    first_open_at = case when cls.all_bulk then null when cls.first_bulk then cls.last_open_at else cls.first_open_at end,
    last_open_at  = case when cls.all_bulk then null when cls.last_bulk then cls.first_open_at else cls.last_open_at end
from cls where cls.token = t.token;
