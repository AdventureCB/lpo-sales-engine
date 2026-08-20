-- Client-side crash telemetry. The companion (WKWebView) has no devtools, so
-- when a rep hits the Next.js "Application error" page this is the only way
-- to see the actual stack. Written by /api/client-error (session-auth'd).

create table client_errors (
  id uuid primary key default gen_random_uuid(),
  user_email text,
  kind text,                       -- error | rejection | boundary | global
  message text,
  stack text,
  url text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index idx_client_errors_at on client_errors (created_at desc);

alter table client_errors enable row level security;
