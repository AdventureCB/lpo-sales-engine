-- Ad attribution per contact: first/last touch UTMs + click ids, captured
-- first-party by public/attr.js and ingested via Shopify order attributes
-- and Klaviyo profile properties. Shape:
-- { first: {source,medium,campaign,content,term,gclid,fbclid,...,lp,ref,at},
--   last: {...}, updated_at }
alter table crm_contacts add column if not exists attribution jsonb;
