-- Channel click counts (from TW summary) beside spend — powers real CPC
-- pricing of individual ad interactions on the deal page.
alter table ad_spend add column if not exists clicks integer;
