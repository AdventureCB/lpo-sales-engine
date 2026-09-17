-- Outcome bonus on call reviews (Kyle 9/16): a call can execute the framework
-- poorly (low scorecard) yet succeed. +1 for a deposit, +2 for paid-in-full
-- (won). Auto-detected going forward; admins can override. Effective score =
-- min(5, scorecard + bonus). Separately, confirmation calls (deal already had
-- a deposit BEFORE the call) aren't StoryBrand prospecting → not scored.
alter table call_reviews add column if not exists bonus smallint not null default 0;
alter table call_reviews add column if not exists bonus_by text; -- 'auto' | admin email
