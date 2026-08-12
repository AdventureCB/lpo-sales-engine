-- Business-hours gate for pg_cron jobs. Fluid Active CPU on Vercel is
-- dominated by the nodejs runtime booting for scheduled work; gating the
-- pg_cron command on this predicate means net.http_get (and therefore the
-- Vercel function) never fires outside the window — zero boot, zero CPU.
--
-- Window: 5:00am–5:59pm PT, every day. Reps start earliest 6:30am and need
-- live data through 6pm; the 5:00–6:30 head start lets normal cadence clear
-- the overnight backlog before login (no separate "morning prep" needed).
-- 6pm–5am the pollers sleep — webhooks (Telnyx/Typeform/Pipedrive/Shopify)
-- still land instantly, so nothing time-critical is missed.
--
-- LA-local extraction is DST-safe (unlike hardcoded UTC hours in the cron
-- schedule, which would drift an hour twice a year). Bump the bounds here to
-- widen the window — every gated job reads this one function.
create or replace function public.is_work_window()
returns boolean
language sql
stable
as $$
  select extract(hour from (now() at time zone 'America/Los_Angeles'))::int
         between 5 and 17;
$$;
