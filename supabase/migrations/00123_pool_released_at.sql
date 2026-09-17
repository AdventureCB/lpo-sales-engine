-- Sprint-list recycling fix (Kyle 9/17): a deal released to the reprospect pool
-- must sit out a HARD 30-day cooldown before another rep can claim it — no more
-- rep→rep recycling of the same unworked deals while the uncontacted backlog
-- starves. The lease-expiry path is derivable from crm_reprospect_checkouts, but
-- the lost-to-pool path (a rep marks a deal lost with a reprospect category) can
-- release an OWNED deal that never had a checkout row — so we stamp the moment of
-- release here and the cooldown reads both signals.
alter table crm_deals add column if not exists pool_released_at timestamptz;

create index if not exists crm_deals_pool_released_at_idx
  on crm_deals (pool_released_at)
  where pool_released_at is not null;
