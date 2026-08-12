-- Close the one table missing RLS. anon/authenticated hold Supabase's
-- default full grants on every public table; RLS is what neutralizes them,
-- and area_code_tz (an early table) never had it enabled — leaving it
-- readable AND truncatable via the public anon key. No policy needed: all
-- app access is server-side via the service-role key, which bypasses RLS.
-- The tz_offset trigger reads this table under the service role, so it is
-- unaffected.
alter table area_code_tz enable row level security;
