-- Per-tool engagement sessions from the companion's native tool windows
-- (Gorgias/Shopify/ClickUp/Calendly/browser/Ops). The companion emits
-- focus/blur for each tool window; the web app closes a session on blur and
-- posts it here. Feeds rep engagement reporting.

create table tool_sessions (
  id uuid primary key default gen_random_uuid(),
  rep_email text not null,
  tool text not null,
  focused_at timestamptz not null,
  blurred_at timestamptz not null,
  duration_s integer not null,
  created_at timestamptz not null default now()
);

create index idx_tool_sessions_rep_day on tool_sessions (rep_email, focused_at desc);
create index idx_tool_sessions_tool on tool_sessions (tool, focused_at desc);

alter table tool_sessions enable row level security;
