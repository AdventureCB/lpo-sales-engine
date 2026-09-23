-- Demo Finder eligibility (Kyle 9/23): only owners whose camper order is
-- FULFILLED (and not cancelled / refunded) count as having a camper. An
-- unfulfilled order, or a deposit that was later cancelled, no longer
-- surfaces in the finder. The sync stamps these on every scan.
alter table camper_owners
  add column if not exists eligible boolean not null default true,
  add column if not exists eligibility_reason text,
  add column if not exists scan_token text;
create index if not exists idx_camper_owners_eligible on camper_owners (eligible) where eligible;
