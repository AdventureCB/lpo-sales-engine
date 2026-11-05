-- Ops quotes: who originated the quote (Ops is opening to ambassadors and
-- installers as their sales tool — the rep needs to see another team is on
-- the deal) and demos other organizations report having done (Kyle 11/5).
alter table ops_quotes add column if not exists originator jsonb;   -- {name, email, organization, role}
alter table ops_quotes add column if not exists demos jsonb;        -- [{organization, by, at, note}]
