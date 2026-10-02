-- PostgREST runs every API request under `authenticator` (statement_timeout
-- 8s) and then impersonates the key's role; the impersonated role's own
-- settings win. service_role had none, so admin reports that fan out ten
-- RPCs at once were hitting 8s ("canceling statement due to statement
-- timeout"), as was the hourly order sync's resolve step. anon/authenticated
-- keep their short limits.
alter role service_role set statement_timeout = '60s';
alter role service_role set lock_timeout = '30s';
notify pgrst, 'reload config';
