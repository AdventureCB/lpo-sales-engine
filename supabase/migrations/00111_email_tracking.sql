-- Email open/click tracking for rep Gmail sends. One row per tracked send;
-- links are stored at send time and referenced by index (no open-redirect).
-- Service-role access only (RLS on, no policies — house rule).

create table if not exists email_tracking (
  token uuid primary key,
  activity_id uuid,
  deal_id uuid,
  rep_email text,
  to_email text,
  subject text,
  links jsonb not null default '[]'::jsonb,
  opens int not null default 0,
  first_open_at timestamptz,
  last_open_at timestamptz,
  clicks int not null default 0,
  last_click_at timestamptz,
  created_at timestamptz not null default now()
);
alter table email_tracking enable row level security;
create index if not exists idx_email_tracking_activity on email_tracking (activity_id);
create index if not exists idx_email_tracking_deal on email_tracking (deal_id);

create table if not exists email_track_clicks (
  id bigserial primary key,
  token uuid not null,
  link_index int,
  url text,
  at timestamptz not null default now()
);
alter table email_track_clicks enable row level security;
create index if not exists idx_email_track_clicks_token on email_track_clicks (token);

-- Atomic counters callable from the public endpoints.
create or replace function public.email_track_open(p_token uuid)
returns void language sql security definer as $$
  update email_tracking
  set opens = opens + 1,
      first_open_at = coalesce(first_open_at, now()),
      last_open_at = now()
  where token = p_token;
$$;

create or replace function public.email_track_click(p_token uuid, p_index int)
returns text language plpgsql security definer as $$
declare v_url text;
begin
  select links->>p_index into v_url from email_tracking where token = p_token;
  if v_url is null then return null; end if;
  update email_tracking set clicks = clicks + 1, last_click_at = now() where token = p_token;
  insert into email_track_clicks (token, link_index, url) values (p_token, p_index, v_url);
  return v_url;
end;
$$;
