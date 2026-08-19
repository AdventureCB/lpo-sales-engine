-- Phase 3: per-deal scripts & drafts. deal_profiles.scripts holds the cached
-- outputs keyed by profile version: { call: {...}, call_version, call_at,
-- email: {...}, email_version, email_at, sms: {...}, sms_version, sms_at }.
alter table deal_profiles add column if not exists scripts jsonb not null default '{}'::jsonb;

-- Asset link understanding: a one-time AI summary of what each URL asset's
-- page actually is/offers, so drafts can reference links meaningfully.
-- link_summary_src stores the URL it was summarized from (re-summarize when
-- the URL changes).
alter table comm_assets add column if not exists link_summary text;
alter table comm_assets add column if not exists link_summary_src text;
