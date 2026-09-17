-- Sprint-list refinements (Kyle 9/17): distinguish a deal RELEASED-TO-POOL by a
-- rep marking it lost (needs 30-day cooldown AND a fresh hot-list signal before
-- it resurfaces — don't bother someone before they're ready) from a lease that
-- simply expired (30-day cooldown alone). pool_released_at already marks the
-- lost-to-pool moment; store the reason too so sprint lists can flag the deal
-- "Previously marked lost — <reason>" when it comes back.
alter table crm_deals add column if not exists pool_released_reason text;
