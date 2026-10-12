-- Reps can flag a review they believe was mis-scored or shouldn't count;
-- admins resolve. {by, at, note, status: open|resolved, resolution, resolved_by, resolved_at, resolution_note}
alter table call_reviews add column if not exists flag jsonb;
create index if not exists idx_call_reviews_flag_open on call_reviews ((flag->>'status')) where flag is not null;
