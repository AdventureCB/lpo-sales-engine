-- Demo Finder addresses come from BILLING (the owner's home), not shipping
-- (which is the INSTALLER — Kyle 9/15). address_manual protects a rep's
-- hand-entered correction (customer moved) from being overwritten by sync.
alter table camper_owners add column if not exists address_manual boolean not null default false;
