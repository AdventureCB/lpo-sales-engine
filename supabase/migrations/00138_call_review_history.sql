-- Call reviews keep every prior version when overwritten (Kyle 9/23: a
-- review silently re-scored 4/5 → 3.5/5 and the original was gone). Each
-- entry: {review, input_hash, transcript_chars, model, bonus,
-- excluded_from_score, updated_at, reason}. Admins can restore from it.
alter table call_reviews add column if not exists history jsonb not null default '[]'::jsonb;
