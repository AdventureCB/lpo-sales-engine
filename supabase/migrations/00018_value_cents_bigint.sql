-- Deal values arrive from Pipedrive uncapped (junk entries like $999,999,999
-- exist); in cents that overflows int4, so store as bigint.
alter table crm_deals alter column value_cents type bigint;
